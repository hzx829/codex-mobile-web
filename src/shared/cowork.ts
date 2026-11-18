const projectId = '(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|(?:claude_proj|proj)_[a-z0-9]+)';
export const coworkProjectPath = new RegExp(`^/(?:project|cowork/projects?)/${projectId}$`, 'i');
export const coworkThreadPath = /^\/cowork\/(?:cse|session|local)_[a-z0-9-]{6,120}$/i;

export function coworkThreadUrl(path: string) {
  return coworkThreadPath.test(path) ? 'https://claude.ai' + path : '';
}
