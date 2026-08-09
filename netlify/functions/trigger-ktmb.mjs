export default async () => {
  const token = process.env.GITHUB_WORKFLOW_TOKEN;

  if (!token) {
    throw new Error('Missing Netlify environment variable: GITHUB_WORKFLOW_TOKEN');
  }

  const response = await fetch(
    'https://api.github.com/repos/edwardd767/ktmb-seat-monitor/actions/workflows/monitor.yml/dispatches',
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ktmb-seat-monitor-netlify-scheduler'
      },
      body: JSON.stringify({ ref: 'main' })
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub workflow dispatch failed: ${response.status} ${body}`);
  }

  console.log('KTMB GitHub workflow dispatched successfully.');
};

export const config = {
  schedule: '*/5 * * * *'
};
