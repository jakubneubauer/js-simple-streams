import {LimitedBlockingQueue} from "@jakubneubauer/limited-blocking-queue";

const NOOP = () => {
    return Promise.resolve();
};

const EOF = Symbol("EOF")

export interface ReaderController {
    enqueue(chunk: any): Promise<any>
    close(): Promise<any>
    error(e?: any): void
}

export interface WriterController {
    error(e?: any): void
}

export interface ReaderSource {
    pull?(controller: ReaderController): Promise<any>;
    start?(controller: ReaderController): any;
    cancel?(): any;
}

export interface WriterSink {
    write?(chunk: any, controller: WriterController): Promise<any>
    close?(controller: WriterController): Promise<any>
    abort?(reason: any): Promise<any>
    start?(controller: WriterController): Promise<any>
}

export interface TransformerSource {
    transform?(chunk: any, controller: ReaderController): Promise<any>
    flush?(controller: ReaderController): Promise<any>
}

export class ReaderOptions {
    public bufferSize?: number
}

export class Reader {
    private closed: boolean;
    private isError: boolean;
    private error: any;
    private pullAlg?: (controller: ReaderController) => Promise<any>;
    private readonly cancelAlg: () => any;
    private readonly bufferSize: number;
    private readonly buffer: LimitedBlockingQueue;
    readonly controller: ReaderController & {reader: Reader};

    constructor(source: ReaderSource, options?: ReaderOptions) {
        this.closed = false;
        this.isError = false;
        this.error = undefined;
        this.pullAlg = source.pull?.bind(source);
        let startAlg = (source.start ?? NOOP).bind(source);
        this.cancelAlg = (source.cancel ?? NOOP).bind(source);
        this.bufferSize = options?.bufferSize ?? 100;
        this.buffer = new LimitedBlockingQueue(this.bufferSize);
        this.controller = {
            reader: this,
            enqueue(chunk) {
                if(this.reader.closed) return Promise.reject("Reader is closed");
                return this.reader.buffer.push(chunk);
            },
            close(reason: any = undefined) {
                if(this.reader.closed) return Promise.resolve()
                this.reader.pullAlg = undefined;
                return this.reader.buffer.push(EOF).then(() => {this.reader.closed = true; this.reader.buffer.close(reason,true);});
            },
            error(reason: any = undefined) {
                if(this.reader.closed || this.reader.isError) return
                // this.reader.closed = true;
                this.reader.isError = true;
                this.reader.error = reason;
                this.reader.pullAlg = undefined;
                this.reader.buffer.close(reason);
            }
        }
        let startResult = startAlg(this.controller);
        Promise.resolve(startResult).then(() => {
            // start pulling in advance to be some data buffered as soon as possible
            // But do this only after the source.start finishes.
            this._pullIfNeeded()
        })
    }

    private _pullIfNeeded() {
        if (this.pullAlg) {
            this.pullAlg(this.controller)
                .then(() => {
                    this._pullIfNeeded()
                })
        }
    }

    read(): Promise<any> {
        return this.buffer.pull().then((chunk) => {
            if (chunk === EOF) {
                this.closed = true;
                return {done: true, value: undefined};
            } else {
                return {done: false, value: chunk};
            }
        }, (e) => {
            if (this.isError) {
                return Promise.reject(this.error);
            }
            if((e as Error)?.message == 'Queue is closed') {
                return {done: true, value: undefined};
            } else {
                return Promise.reject(e);
            }
        })
    }

    async close() {
        this.closed = true;
        this.buffer.close();
        await this.cancelAlg();
    }

    pipeThrough(destination: ReaderWriter): Reader {
        let pipeOneChunk = () => {
            this.read()
                .then((chunk) => {
                    if (chunk.done) {
                        return destination.writer.close();
                    } else {
                        return destination.writer
                            .write(chunk.value)
                            .then(pipeOneChunk);
                    }
                }, (reason) => {
                    return destination.writer.abort(reason);
                });
        }
        pipeOneChunk();
        return destination.reader;
    }

    async pipeTo(destination: Writer) {
        try {
            while (true) {
                let chunk = await this.read();
                if (chunk.done) {
                    await destination.close();
                    return;
                }
                await destination.write(chunk.value);
            }
        } catch (e) {
            await destination.abort(e);
            throw e;
        }
    }

    [Symbol.asyncIterator]() {
        let r = this;
        return {
            next() {
                // our reader returns the same format as the async iterable should - {done,value}
                return r.read();
            },
            return() {
                // This will be reached if the consumer called 'break' or 'return' early in the loop.
                return {done: true, value: undefined};
            }
        };
    }
}

export class Writer {
    private sink: WriterSink;
    private isClosed = false;
    private isError = false;
    private error: any = undefined;
    private readonly writeAlg: (chunk: any, controller: WriterController) => Promise<any>;
    private readonly closeAlg: (controller: WriterController) => Promise<any>;
    private readonly abortAlg: (_: any) => Promise<any>;
    private readonly controller: WriterController & {writer: Writer};
    private startPromise: Promise<any>;
    private isStarted: boolean = false; 
    private waitingWrites: ([(_:any)=>any, (_:any)=>any])[] = []
    private writePending = false;

    constructor(sink: WriterSink) {
        this.sink = sink;
        this.writeAlg = (sink.write ?? NOOP).bind(sink);
        this.closeAlg = (sink.close ?? NOOP).bind(sink);
        this.abortAlg = (sink.abort ?? NOOP).bind(sink);
        let startAlg = (sink.start ?? NOOP).bind(sink);
        
        this.controller = {
            writer: this,
            error(reason?: any) {
                this.writer.isError = true;
                this.writer.error = reason;
            }
        }
        this.startPromise = startAlg(this.controller).then(() => {this.isStarted = true});
    }
    
    private writeImpl(chunk: any): Promise<any> {
        if (this.isClosed) {
            return Promise.reject("Writer is closed");
        }
        if (this.isError) {
            return Promise.reject(this.error ?? new Error("Writer is aborted"));
        }
        this.writePending = true;
        return this.writeAlg(chunk, this.controller)
            .then(() => {
                this.writePending = false;
                // release waiting write operation if any
                if (this.waitingWrites.length > 0) {
                    this.waitingWrites.shift()![0](undefined)
                }
            }, (reason) => {
                this.writePending = false;
                // release waiting write operation if any
                if (this.waitingWrites.length > 0) {
                    this.waitingWrites.shift()![0](undefined)
                }
                return Promise.reject(reason)
            })
    }

    write(chunk: any): Promise<any> {
        if (!this.isStarted) {
            return this.startPromise.then(() => {
                return this.write(chunk);
            })
        }
        if(this.writePending) {
            return new Promise((resolve, reject) => {
                this.waitingWrites.push([resolve, reject]);
            }).then(() => {
                return this.writeImpl(chunk);
            })
        } else {
            return this.writeImpl(chunk);
        }
    }
    
    async close() {
        if (!this.isStarted) {
            await this.startPromise
        }
        this.isClosed = true;
        await this.closeAlg(this.controller);
    }
    
    async abort(reason: any = undefined) {
        this.isError = true;
        this.error = reason;
        await this.abortAlg(reason);
        return reason
    }
}

interface ReaderWriter {
    reader: Reader
    writer: Writer
}

export class Transformer implements ReaderWriter{
    public reader: Reader
    public writer: Writer
    private readonly transformAlg: (chunk: any, controller: ReaderController) => Promise<any>
    private readonly flushAlg: (controller: ReaderController) => Promise<any>
    private readonly controller: ReaderController

    constructor(transformImpl: TransformerSource) {
        this.transformAlg = (transformImpl.transform ?? NOOP).bind(transformImpl);
        this.flushAlg = (transformImpl.flush ?? NOOP).bind(transformImpl);
        this.reader = new Reader({})
        this.controller = this.reader.controller;
        this.writer = new Writer({
            write: (chunk) => {
                return this.transformAlg(chunk, this.controller);
            },
            close: async () => {
                await this.flushAlg(this.controller);
                return this.controller.close();
            },
            abort: async (reason) => {
                await this.controller.error(reason);
            }
        });
    }
}
