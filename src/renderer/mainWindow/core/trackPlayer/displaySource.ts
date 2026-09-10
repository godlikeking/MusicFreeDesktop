/**
 * DisplaySource — “显示来源”派生层
 *
 * 换源（mediaMeta.associatedSource）不改变歌曲身份 (platform,id)，
 * 仅在 UI 的“来源”标签上展示关联音源的平台。
 *
 * 数据来源：
 * - 切歌时按需查询 mediaMeta（IPC + 内存缓存）
 * - mediaMeta 变更广播（含换源写入、跨窗口同步）实时更新
 * - 列表组件挂载时调用 preloadDisplayPlatforms 批量预加载
 */
import { compositeKey } from '@common/mediaKey';
import mediaMeta from '@infra/mediaMeta/renderer';
import { store, currentMusicAtom, displayPlatformAtom } from './store';

function setOne(key: string, displayPlatform: string | null) {
    const map = store.get(displayPlatformAtom);
    if (displayPlatform) {
        if (map[key] === displayPlatform) return;
        store.set(displayPlatformAtom, { ...map, [key]: displayPlatform });
    } else if (key in map) {
        const next = { ...map };
        delete next[key];
        store.set(displayPlatformAtom, next);
    }
}

/** 查询单首歌的关联音源平台并同步到 atom */
async function refreshItem(item: { platform: string; id: string | number } | null) {
    if (!item) return;
    const musicId = String(item.id);
    let meta: Awaited<ReturnType<typeof mediaMeta.getMeta>> = null;
    try {
        meta = await mediaMeta.getMeta(item.platform, musicId);
    } catch {
        meta = null;
    }
    setOne(compositeKey(item.platform, musicId), meta?.associatedSource?.platform ?? null);
}

/**
 * 批量预加载列表中歌曲的显示来源（列表组件挂载/数据变化时调用）。
 * 仅查询换过源的歌曲（associatedSource 存在）。
 */
export async function preloadDisplayPlatforms(
    items: Array<{ platform: string; id: string | number } | null | undefined>,
): Promise<void> {
    const valid = items.filter((it): it is { platform: string; id: string | number } => !!it);
    if (valid.length === 0) return;

    await mediaMeta.preload(valid.map((it) => ({ platform: it.platform, id: String(it.id) })));

    for (const it of valid) {
        const musicId = String(it.id);
        const meta = mediaMeta.getMetaSync(it.platform, musicId);
        if (meta?.associatedSource?.platform) {
            setOne(compositeKey(it.platform, musicId), meta.associatedSource.platform);
        }
    }
}

/** 读取某首歌当前应显示的来源平台（同步，缺省回退原平台） */
export function getDisplayPlatform(
    item?: {
        platform: string;
        id: string | number;
    } | null,
): string | undefined {
    if (!item) return undefined;
    const map = store.get(displayPlatformAtom);
    return map[compositeKey(item.platform, String(item.id))] ?? item.platform;
}

let inited = false;

/** 初始化：切歌时查询 + 订阅 mediaMeta 变更广播。应用启动时调用一次 */
export function setupDisplaySource(): void {
    if (inited) return;
    inited = true;

    // 切歌时加载当前歌曲的显示来源
    store.sub(currentMusicAtom, () => {
        refreshItem(store.get(currentMusicAtom));
    });
    refreshItem(store.get(currentMusicAtom));

    // 换源写入 / 其他窗口的变更
    mediaMeta.onMetaChanged((event) => {
        const { platform, musicId, meta } = event;
        setOne(compositeKey(platform, musicId), meta?.associatedSource?.platform ?? null);
    });
}
