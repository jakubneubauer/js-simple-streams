import {Reader, Writer, Transformer} from "./dist/index.js";
import {ReadableStream, TransformStream, WritableStream} from 'stream/web';

const chunksCount = 1_000;
const benchTime = 5_000;
const warmupTime = 2_000;

(async function() {

    let resultSimpleStreams = await bench("simple-streams identity transform", benchTime, async () => {
        let reader = new Reader({
            async start(controller) {
                for (let i = 0; i < chunksCount; i++) {
                    await controller.enqueue(i);
                }
                await controller.close();
            }
        });
        let transformer = new Transformer({
            transform(chunk, controller) {
                return controller.enqueue(chunk);
            }
        })
        let writer = new Writer({});
        await reader
            .pipeThrough(transformer)
            .pipeTo(writer);
    }, warmupTime);

    let resultBuiltInStreams = await bench("built-in web-streams identity transform", benchTime, async () => {
        let reader = new ReadableStream({
            async start(controller) {
                for (let i = 0; i < chunksCount; i++) {
                    await controller.enqueue(i);
                }
                await controller.close();
            }
        });
        let transformer = new TransformStream({
            transform(chunk, controller) {
                return controller.enqueue(chunk);
            }
        })
        let writer = new WritableStream({});
        await reader
            .pipeThrough(transformer)
            .pipeTo(writer);
    }, warmupTime);
    
    console.log("simple-streams / built-in = " + (resultSimpleStreams.rate / resultBuiltInStreams.rate));
})();

async function bench(name, time, func, warmupTime = 1000) {
    console.log(name + ": warming up...");
    await benchImpl(func, warmupTime);
    console.log(name + ": running bench...");
    let result = await benchImpl(func, time);
    console.log(name + ": result: " + JSON.stringify(result));
    return result;
}

async function benchImpl(func, time) {
    let counter = 0;
    let benchStart = performance.now();
    let timeout = benchStart + time;
    let chunkSize = 1;
    while(true) {
        let start = performance.now();
        if (start > timeout) {
            break;
        }
        // console.log("Running chunk of size " + chunkSize)
        for(let i = 0; i < chunkSize; i++) {
            counter++;
            await func();
        }
        let duration = performance.now() - start;
        if (duration  < time / 16) {
            chunkSize *= 2;
        }
    }
    let benchEnd = performance.now();
    let benchDur = benchEnd - benchStart;
    let ratePerSec = 1000 * counter / benchDur;
    return {rate: ratePerSec, count: counter, time: benchDur};
}
