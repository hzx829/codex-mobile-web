import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';

export async function copyWindowsRuntime(target: string) {
  if (process.platform !== 'win32') throw new Error('Windows 便携包请在 Windows 构建');
  const runtime = join(target, 'runtime');
  await mkdir(runtime, {recursive: true});
  await copyFile(process.execPath, join(runtime, 'node.exe'));
  const licenseCache = resolve('.local', 'licenses', `node-${process.version}-LICENSE.txt`);
  let license = '';
  try {license = await readFile(process.env.NODE_LICENSE_FILE || licenseCache, 'utf8');} catch {}
  if (!license) for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, {signal: AbortSignal.timeout(10000)});
      if (response.ok) {license = await response.text();break;}
    } catch {}
  }
  if (!license.includes('Node.js is licensed for use as follows') || license.length < 10000)
    throw new Error('无法获取该版本 Node 的完整许可证。可设置 NODE_LICENSE_FILE 指向同版本官方 LICENSE 后重试。');
  await mkdir(dirname(licenseCache), {recursive: true});
  await writeFile(licenseCache, license);
  await writeFile(join(runtime, 'NODE-LICENSE.txt'), license);
}
