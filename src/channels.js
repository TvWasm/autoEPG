import { readFileSync } from 'node:fs';

const profiles = JSON.parse(readFileSync(new URL('./channel-profiles.json', import.meta.url), 'utf8'));

export const GROUPS = [
  { id: 'cctv', name: '央视频道', sourceType: 'yangshi' },
  { id: 'weishi', name: '卫视频道', sourceType: 'weishi' },
  { id: 'provincial', name: '省级频道', sourceType: 'provincial' },
];

export function channelProfile(pid, sourceName, sourceType) {
  const profile = profiles[pid];
  const group = GROUPS.find(g => g.sourceType === sourceType);
  if (!group) throw new Error(`Unknown channel group ${sourceType} for ${pid}`);
  return {
    id: profile?.id ?? `ysp${pid}`, name: profile?.name ?? sourceName,
    sourceName, aliases: profile?.aliases ?? [sourceName],
    legacyIds: [`ysp.${pid}`], groupId: group.id, group: group.name,
    order: profile?.order ?? 1000,
  };
}

export function groupedChannels(channels) {
  const rank = new Map(GROUPS.map((g, i) => [g.id, i]));
  return [...channels].sort((a, b) => (rank.get(a.groupId) ?? 99) - (rank.get(b.groupId) ?? 99) ||
    (a.order ?? 1000) - (b.order ?? 1000) || a.id.localeCompare(b.id, 'en', { numeric: true }));
}

export function groupFile(file, groupId) {
  return file.replace(/\.xml$/, `-${groupId}.xml`);
}
