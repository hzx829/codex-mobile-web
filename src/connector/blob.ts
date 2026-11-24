import {request as httpRequest, type IncomingMessage} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {pipeline} from 'node:stream/promises';
import {BridgeError} from '../shared/types.js';
import {FileStream} from './project.js';
import {UploadBody} from './attachments.js';
export {BLOB_ACTIONS, BLOB_UPLOADS} from '../shared/protocol.js';

/**
 * The connector's side of the relay's data channel (docs/sync/DESIGN.md §8). The relay asks for a file with a `blob.pull`
 * on the control connection; the connector answers with one HTTP POST to `/blob-feed/<stream>` whose body is the file's
 * bytes, so files never pass through the chat connection as base64. What went wrong travels in headers.
 */

const STATUS: Record<string, number> = {invalid: 400, range: 416, forbidden: 403, not_found: 404, missing: 404, changed: 409, too_large: 413, unsupported: 400, offline: 503};

/** Opens the file with `open` (the download action, which keeps all its checks) and sends it, or the error, to the relay. */
export async function sendBlob(relayUrl: string, stream: string, open: () => Promise<unknown>): Promise<void> {
  let file: FileStream | undefined, status = 200, headers: Record<string, string> = {};
  try {
    const result = await open();
    if (!(result instanceof FileStream)) throw new BridgeError('invalid', '这个文件不能这样下载');
    file = result;
    const length = file.size ? file.end - file.start + 1 : 0;
    status = file.start > 0 || file.end < file.size - 1 ? 206 : 200;
    headers = {'x-blob-status': String(status), 'x-blob-size': String(file.size), 'x-blob-start': String(file.start), 'x-blob-end': String(file.end),
      'x-blob-mime': file.mime, 'x-blob-name': encodeURIComponent(file.name), 'content-length': String(length)};
  } catch (error) {
    const known = error instanceof BridgeError ? error : new BridgeError('computer_error', '电脑读取文件失败');
    headers = {'x-blob-status': String(STATUS[known.code] || 502), 'x-blob-error': encodeURIComponent(known.message), 'content-length': '0'};
  }
  const url = new URL(`/blob-feed/${encodeURIComponent(stream)}`, relayUrl);
  const post = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {method: 'POST', headers: {...headers, 'content-type': 'application/octet-stream'}});
  const answered = new Promise<void>((resolve, reject) => {post.on('response', response => {response.resume();response.on('end', resolve);});post.on('error', reject);});
  try {
    if (file && file.size) await pipeline(file.handle.createReadStream({start: file.start, end: file.end, autoClose: false}), post);
    else post.end();
    await answered;
  } catch { /* The phone left or the relay went away; nothing waits for this answer. */ } finally {
    await file?.handle.close().catch(() => {});
  }
}

/**
 * Receives one upload part through the data channel: the relay asked with `blob.push`, the connector fetches
 * `/blob-sink/<stream>` (the phone's request body, passed through) and hands it to `write`, the upload action. What the
 * action answered, or why it failed, goes back on the control connection as `blob.done`.
 */
export async function receiveBlob(relayUrl: string, stream: string, length: number, write: (body: UploadBody) => Promise<unknown>): Promise<{result?: unknown; error?: {code: string; message: string}}> {
  const url = new URL(`/blob-sink/${encodeURIComponent(stream)}`, relayUrl);
  let response: IncomingMessage | undefined;
  try {
    response = await new Promise<IncomingMessage>((resolve, reject) => {
      const get = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {method: 'GET'}, resolve);
      get.on('error', reject);get.end();
    });
    if (response.statusCode !== 200) throw new BridgeError('offline', '上传已中断，请重试');
    return {result: await write(new UploadBody(response, length))};
  } catch (error) {
    const known = error instanceof BridgeError ? error : new BridgeError('upload_failed', '附件写入失败，请重试');
    return {error: {code: known.code, message: known.message}};
  } finally {response?.resume();}
}
