import {Reader, Writer, Transformer, WriterSink, ReaderSource, ReaderController} from "../src";

class IMWS implements WriterSink {
    result: string = ""
    write(chunk: any): Promise<any> {
        this.result += chunk;
        return Promise.resolve(undefined);
    }
    close(): Promise<any> {
        this.result += ".";
        return Promise.resolve(undefined);
    }
}

class InMemoryWriter extends Writer {
    mysink: IMWS
    constructor() {
        let sink = new IMWS()
        super(sink);
        this.mysink = sink;
    }

    get result() {
        return this.mysink.result;
    }
}

class FixedReaderSource implements ReaderSource {
    index = 0
    data: any[]
    constructor(data: any[]) {
        this.data = data;
    }
    async pull(controller: ReaderController) {
        if (this.index >= this.data.length) {
            await controller.close();
            return;
        }
        await controller.enqueue(this.data[this.index++]);
    }
}

class FixedReader extends Reader {
    constructor(data: any[]) {
        super(new FixedReaderSource(data));
    }
}

class ParenthesizingTransformer extends Transformer {
    constructor() {
        super({
            transform(chunk: any, controller: ReaderController) {
                return controller.enqueue("(" + chunk + ")");
            }
        });
    }
}

test("reader - read after EOF", async () => {
    let reader = new Reader({
        async start(controller) {
            await controller.enqueue(1);
            await controller.close();
        },
    });

    // read multiple time in advance
    let result1 = await reader.read();
    expect(result1.value).toBe(1);
    let result2 = await reader.read();
    expect(result2.done).toBe(true);
    let result3 = await reader.read();
    expect(result3.done).toBe(true);
});

test("reader - read in parallel time before pull", async () => {
    let pullItems = ['a', 'b', 'c'];

    let reader = new Reader({
        async start(controller) {
            await controller.enqueue(1);
        },
        async pull(controller) {
            // sleep to be slower than the consumer
            await new Promise(resolve => setTimeout(resolve, 20))
            if (pullItems.length > 0) {
                await controller.enqueue(pullItems.shift())
            } else {
                await controller.close();
            }
        }
    }, {bufferSize: 2});
    
    // read multiple time in advance
    let p1 = reader.read();
    let p2 = reader.read();
    let p3 = reader.read();
    let p4 = reader.read();
    let p5 = reader.read();

    expect((await p1).value).toBe(1);
    expect((await p2).value).toBe('a');
    expect((await p3).value).toBe('b');
    expect((await p4).value).toBe('c');
    expect((await p5).done).toBe(true);
});

test("reader - slow reader", async () => {

    let pullItems = ['a', 'b', 'c'];

    let reader = new Reader({
        async start(controller) {
            await controller.enqueue(1);
            await controller.enqueue(2);
            await controller.enqueue(3);
        },
        async pull(controller) {
            if (pullItems.length > 0) {
                await controller.enqueue(pullItems.shift())
            } else {
                await controller.close();
            }
        }
    }, {bufferSize: 2});
    
    // Wait a little bit, to be sure that the pulling alg is blocked in enqueueing.
    await new Promise(resolve => setTimeout(resolve, 100))

    let result = "";
    let chunk = await reader.read();
    while (!chunk.done) {
        result += chunk.value;
        await new Promise(resolve => setTimeout(resolve, 50))
        chunk = await reader.read();
    }
    expect(result).toBe("123abc")
});

test("reader - 'start' provides all data", async () => {
    let reader = new Reader({
        async start(controller) {
            for (let i = 0; i < 10; i++) {
                await controller.enqueue(i);
            }
            await controller.close();
        }
    }, {bufferSize: 5});
    expect(await readAllToString(reader)).toBe("0123456789")
});

test("reader - async iterator", async () => {
    let reader = new Reader({
        async start(controller) {
            await controller.enqueue('a');
            await controller.enqueue('b');
            await controller.close();
        }
    });
    let result = "";
    for await (let chunk of reader) {
        result += chunk
    }
    expect(result).toBe("ab")
});

test("writer - basic test", async () => {
    let result = "";
    let writer = new Writer({
        async write(chunk) {
            result += chunk;
        },
        async close() {
            result += ".";
        }
    });
    await writer.write("a");
    await writer.write("b");
    await writer.close();
    expect(result).toBe("ab.");
});

test("reader writer - pipeTo", async () => {
    let r = new FixedReader([1, 2, 3]);
    let w = new InMemoryWriter();
    await r.pipeTo(w);
    expect(w.result).toBe("123.");
});

test("reader transformer - pipeThrough", async () => {
    let r = new FixedReader([1, 2, 3]);
    let r2 = r.pipeThrough(new ParenthesizingTransformer())
    expect(await readAllToString(r2)).toBe("(1)(2)(3)");
});

test("reader writer transformer - pipeThrough pipeTo", async () => {
    let r = new FixedReader([1, 2, 3]);
    let w = new InMemoryWriter();
    await r
        .pipeThrough(new ParenthesizingTransformer())
        .pipeThrough(new ParenthesizingTransformer())
        .pipeTo(w);
    expect(w.result).toBe("((1))((2))((3)).");
});

test("reader - pending read will succeed after controller close", async() => {
    let pullsRequestedResolve: (_:any) => any = (_) => {};
    let pullsRequestedProm = new Promise((resolve) => {
        pullsRequestedResolve = resolve;
    })
    let r = new Reader({
        async start(controller) {
            // wait for the pull calls.
            await pullsRequestedProm;
            await controller.enqueue(1);
            await controller.close();
        }
    }, {bufferSize: 5});
    let pullProm1 = r.read();
    let pullProm2 = r.read();
    let pullProm3 = r.read();
    // notify the pull operations are called
    pullsRequestedResolve(undefined);
    
    expect((await pullProm1).value).toBe(1);
    expect((await pullProm2).done).toBe(true);
    expect((await pullProm3).done).toBe(true);
});

test("reader - pending read will succeed after reader close", async() => {
    let r = new Reader({}, {bufferSize: 5});
    let pullProm1 = r.read();
    let pullProm2 = r.read();
    let pullProm3 = r.read();
    await r.close();
    expect((await pullProm1).done).toBe(true);
    expect((await pullProm2).done).toBe(true);
    expect((await pullProm3).done).toBe(true);
});

test("reader - pending controller enqueue will fail after close", async () => {
    let enqueueCalledResolve: (_:any) => any = (_) => {};
    let enqueueCalledPromise = new Promise((resolve) => {
        enqueueCalledResolve = resolve;
    })
    let enqueueProm1 = undefined;
    let enqueueProm2 = undefined;
    let r = new Reader({
        async start(controller) {
            enqueueProm1 = controller.enqueue(1);
            enqueueProm2 = controller.enqueue(2);
            // notify that enqueue was called
            enqueueCalledResolve(undefined);
        }
    }, {bufferSize: 1});
    
    // wait for controller.enqueue being called
    await enqueueCalledPromise;
    
    // close the reader
    await r.close();

    // verify that first async enqueue was successful,
    await enqueueProm1;
    // verify that second async enqueue failed - was cancelled by close()
    await expect(enqueueProm2).rejects.toThrow();
    
});

async function readAllToString(reader: Reader) {
    let result = "";
    let chunk = await reader.read();
    while (!chunk.done) {
        result += chunk.value;
        chunk = await reader.read();
    }
    return result;
}
