import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BlobStore, withImageRefs, isImageRef} from '../src/connector/blob-store.js';
import {ThreadHub} from '../src/connector/thread-hub.js';
import {removeTestTemp} from '../scripts/test-temp.js';

const png = (fill: number, size = 100) => `data:image/png;base64,${Buffer.alloc(size, fill).toString('base64')}`;

test('images are kept by content, read back, and the oldest used go first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-images-'));
  try {
    const store = new BlobStore(dir, 250);
    const a = store.putDataUrl(png(1)), again = store.putDataUrl(png(1));
    assert.ok(isImageRef(a));
    assert.equal(again, a, 'The same bytes are one image.');
    assert.equal(store.putDataUrl('https://example.com/x.png'), 'https://example.com/x.png');
    assert.equal(await store.dataUrl(a), png(1));
    assert.deepEqual(await store.resolve(['x', a]), ['x', png(1)]);
    const file = await store.open(a.slice('cmw-image:'.length));
    assert.deepEqual([file.size, file.mime, file.start, file.end], [100, 'image/png', 0, 99]);
    await file.handle.close();
    await utimes(join(dir, a.slice('cmw-image:'.length) + '.png'), new Date(1000), new Date(1000));
    const b = store.putDataUrl(png(2)), c = store.putDataUrl(png(3));
    await assert.rejects(store.dataUrl(a), /不在电脑上/, 'Past the limit the oldest used image is dropped.');
    assert.equal(await store.dataUrl(c), png(3));
    assert.ok(isImageRef(b));
    assert.equal(new BlobStore(dir, 250).putDataUrl(png(3)), c, 'A store opened again knows what it holds.');
  } finally {await removeTestTemp(dir);}
});

test('synced turns carry references once the relay serves images, keeping their revs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cmw-images-hub-'));
  try {
    const store = new BlobStore(dir);
    const plain = {id: 'a', items: [{id: '1', text: 'hi'}]};
    assert.equal(withImageRefs(store, plain), plain);
    const turn = {id: 'b', items: [{id: '2', text: '', images: [png(9)]}]};
    const hub = new ThreadHub(() => {});
    hub.register('claude', {version: async () => '1', state: async () => ({head: {}, entries: [plain, turn]})});
    const before = await hub.open({service: 'claude', threadId: 't'});
    assert.equal(before.entries[1].body.items[0].images[0], png(9), 'Without a relay that serves them, images stay inline.');
    hub.images = store;
    const page = await hub.page({service: 'claude', threadId: 't', before: 'b', limit: 5});
    assert.deepEqual(page.order, ['a']);
    const hub2 = new ThreadHub(() => {});hub2.images = store;
    hub2.register('claude', {version: async () => '1', state: async () => ({head: {}, entries: [plain, turn]})});
    const first = await hub2.open({service: 'claude', threadId: 't'}), second = await hub2.open({service: 'claude', threadId: 't', have: {}});
    assert.ok(isImageRef(first.entries[1].body.items[0].images[0]));
    assert.equal(first.entries[1].rev, second.entries[1].rev, 'The same turn keeps its rev.');
    hub.close();hub2.close();
  } finally {await removeTestTemp(dir);}
});
