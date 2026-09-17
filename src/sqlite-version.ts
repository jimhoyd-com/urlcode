// https://www.sqlite.org/wal.html#the_wal_reset_bug
export function supportsConcurrentWal(version: unknown): boolean {
  const [major=NaN,minor=NaN,patch=NaN]=String(version).split('.').map(Number);
  if(![major,minor,patch].every(Number.isInteger))return false;
  return major>3 || major===3 && (minor>51 || minor===51&&patch>=3 || minor===50&&patch>=7 || minor===44&&patch>=6);
}
