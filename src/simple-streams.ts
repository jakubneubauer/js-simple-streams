import {LimitedBlockingQueue} from "@jakubneubauer/limited-blocking-queue";

const NOOP = () => {
    return Promise.resolve();
};

const EOF = Symbol("EOF")

export interface ReaderController {
    enqueue(chunk: any): Promise<any>
    close(): Promise<any>
}

export interface ReaderSource {
    pull?(controller: ReaderController): Promise<any>;
    start?(controller: ReaderController): any;
    cancel?(): any;
}

export interface WriterSink {
    write?(chunk: any): Promise<any>
    close?(): Promise<any>
}

interface TransformerSource {
    transform?(chunk: any, controller: ReaderController): Promise<any>
    flush?(controller: ReaderController): Promise<any>
}

class ReaderOptions {
    public bufferSize?: number
}

export class Reader {
    private closed: boolean;
    private pullAlg?: (controller: ReaderController) => Promise<any>;
    private readonly startAlg: (controller: ReaderController) => any;
    private readonly cancelAlg: () => any;
    private readonly bufferSize: number;
    private readonly buffer: LimitedBlockingQueue;
    readonly controller: ReaderController & {reader: Reader};

    constructor(source: ReaderSource, options?: ReaderOptions) {
        this.closed = false;
        this.pullAlg = source.pull?.bind(source);
        this.startAlg = (source.start ?? NOOP).bind(source);
        this.cancelAlg = (source.cancel ?? NOOP).bind(source);
        this.bufferSize = options?.bufferSize ?? 100;
        this.buffer = new LimitedBlockingQueue(this.bufferSize);
        this.controller = {
            reader: this,
            enqueue(chunk) {
                if(this.reader.closed) return Promise.reject("Reader is closed");
                return this.reader.buffer.push(chunk);
            },
            close() {
                if(this.reader.closed) return Promise.resolve()
                this.reader.pullAlg = undefined;
                return this.reader.buffer.push(EOF).then(() => {this.reader.buffer.close(true);});
            }
        }
        let startResult = this.startAlg(this.controller);
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

    async read() {
        if (this.closed && this.buffer.length === 0) {
            return {done: true, value: undefined};
        }
        try {
            let chunk = await this.buffer.pull()
            if (chunk === EOF) {
                this.closed = true;
                return {done: true, value: undefined};
            } else {
                return {done: false, value: chunk};
            }
        } catch(e) {
            if((e as Error)?.message == 'Queue is closed') {
                return {done: true, value: undefined};
            } else {
                throw e;
            }
        }
    }

    async close() {
        this.closed = true;
        this.buffer.close();
    }

    pipeThrough(destination: ReaderWriter): Reader {
        let pipeOneChunk = () => {
            this.read().then((chunk) => {
                if (chunk.done) {
                    return destination.writer.close();
                } else {
                    destination.writer
                        .write(chunk.value)
                        .then(pipeOneChunk);
                }
            });
        }
        pipeOneChunk();
        return destination.reader;
    }

    async pipeTo(destination: Writer) {
        while (true) {
            let chunk = await this.read();
            if (chunk.done) {
                await destination.close();
                return;
            }
            await destination.write(chunk.value);
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
    private readonly writeAlg: (chunk: any) => Promise<any>;
    private readonly closeAlg: () => Promise<any>;

    constructor(sink: WriterSink) {
        this.sink = sink;
        this.writeAlg = (sink.write ?? NOOP).bind(sink);
        this.closeAlg = (sink.close ?? NOOP).bind(sink);
    }

    write(chunk: any) {
        return this.writeAlg(chunk);
    }

    close() {
        return this.closeAlg();
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
            }
        });
    }
}
