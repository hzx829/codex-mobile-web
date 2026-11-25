import {INVITE_TTL_MS, TeamError, TeamStore} from './store.js';

const USAGE = `团队命令：
  team init --name <名字> [--url <中继网址>]     启用团队，创建所有者并生成首个邀请链接
  team invite --user <名字> [--url <中继网址>]   给已有成员重新生成邀请链接（例如所有者的设备全丢了）
  team list                                      列出成员和设备数`;

function option(args: string[], name: string) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : undefined;
}

function link(code: string, url: string | undefined) {
  const base = url ? url.replace(/\/+$/, '') : '<中继网址>';
  return `${base}/#invite=${code}`;
}

/** Runs a `team …` command against the relay's database and returns the exit code. */
export function runTeamCommand(args: string[], databasePath: string, print: (line: string) => void = console.log): number {
  const [command] = args;
  if (!command || command === 'help' || command === '--help') {print(USAGE);return command ? 0 : 1;}
  let store: TeamStore;
  try {store = new TeamStore(databasePath);}
  catch (error) {print(`无法打开团队数据库 ${databasePath}：${(error as Error).message}\n请确认中继有可写的数据目录（BRIDGE_DATA），Docker 部署见 DEPLOY.md。`);return 1;}
  try {
    const url = option(args, 'url');
    const hours = INVITE_TTL_MS / 3600_000;
    if (command === 'init') {
      const name = option(args, 'name');
      if (!name) {print('请用 --name 指定所有者的名字');return 1;}
      if (store.enabled) {print('团队已经启用。给已有成员重新发邀请请用 team invite --user <名字>');return 1;}
      const user = store.createUser({name, role: 'owner'});
      const invite = store.createInvite(user.id, null);
      print(`已启用团队，所有者：${user.name}`);
      print(`在手机或电脑浏览器打开这个链接登录（${hours} 小时内有效，只能用一次）：`);
      print(link(invite.code, url));
      print('启用后，手机不能再用共享 Token 登录；电脑连接器仍可继续使用。');
      return 0;
    }
    if (command === 'invite') {
      const name = option(args, 'user');
      const user = name ? store.userByName(name) : undefined;
      if (!user) {print('找不到这个成员。可用 team list 查看名字');return 1;}
      if (user.status !== 'active') store.updateUser(user.id, {status: 'active'});
      const invite = store.createInvite(user.id, null);
      print(`${user.name} 的邀请链接（${hours} 小时内有效，只能用一次）：`);
      print(link(invite.code, url));
      return 0;
    }
    if (command === 'list') {
      const devices = store.devices();
      const users = store.users();
      if (!users.length) {print('还没有启用团队。');return 0;}
      for (const user of users) print(`${user.name}\t${user.role}\t${user.status}\t设备 ${devices.filter(device => device.userId === user.id).length} 台`);
      return 0;
    }
    print(USAGE);
    return 1;
  } catch (error) {
    print(error instanceof TeamError ? error.message : `失败：${(error as Error).message}`);
    return 1;
  } finally {store.close();}
}
