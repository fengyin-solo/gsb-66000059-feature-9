/** 相对时间，如「刚刚」「3 分钟前」「2 小时前」「1 天前」 */
export function getTimeAgo(dateString: string, now: number = Date.now()): string {
  const diff = now - new Date(dateString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 完整的本地日期时间，如 2026/9/19 14:08:32 */
export function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
