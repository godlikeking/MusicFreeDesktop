import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, Check } from 'lucide-react';
import Modal from '@renderer/mainWindow/components/ui/Modal';
import { Input } from '@renderer/mainWindow/components/ui/Input';
import { ScrollArea } from '@renderer/mainWindow/components/ui/ScrollArea';
import TabBar from '@renderer/mainWindow/components/ui/TabBar';
import { Artwork } from '@renderer/mainWindow/components/ui/Artwork';
import { StatusPlaceholder } from '@renderer/mainWindow/components/ui/StatusPlaceholder';
import { showToast } from '@renderer/mainWindow/components/ui/Toast';
import { useCurrentMusic } from '@renderer/mainWindow/core/trackPlayer/hooks';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import pluginManager from '@infra/pluginManager/renderer';
import mediaMeta from '@infra/mediaMeta/renderer';
import { isSameMedia } from '@common/mediaKey';
import formatDuration from '@common/formatDuration';
import { RequestStatus } from '@common/constant';
import './index.scss';

interface SwitchSourceModalProps {
    close: () => void;
    /** 要切换音源的歌曲 */
    musicItem: IMusic.IMusicItem;
}

/** 单个插件的搜索结果 */
interface PluginSearchResult {
    loading: boolean;
    data: IMusic.IMusicItem[];
    error?: boolean;
}

/**
 * SwitchSourceModal — 切换音源业务弹窗
 *
 * 通过 showModal('SwitchSourceModal', { musicItem }) 命令式打开。
 * 在所有支持 music 搜索的插件中并发搜索，点击结果后把该歌曲的音源
 * 关联到目标歌曲（mediaMeta.associatedSource），若为当前播放歌曲则即时换流。
 */
export default function SwitchSourceModal({ close, musicItem }: SwitchSourceModalProps) {
    const { t } = useTranslation();
    const currentMusic = useCurrentMusic();

    // 搜索关键词，默认预填当前歌曲 title + artist
    const defaultQuery = useMemo(
        () =>
            [musicItem.title, musicItem.artist]
                .filter((it) => it && it.trim())
                .join(' ')
                .trim(),
        [musicItem],
    );
    const [query, setQuery] = useState(defaultQuery);

    // 插件列表
    const plugins = useMemo(() => pluginManager.getSearchablePlugins('music'), []);

    // 当前选中的插件 Tab
    const [activePluginKey, setActivePluginKey] = useState(plugins[0]?.hash ?? '');

    // 每个插件的搜索结果
    const [results, setResults] = useState<Record<string, PluginSearchResult>>({});

    // 已关联的音源
    const [linkedItem, setLinkedItem] = useState<IMusic.IMusicItem | null>(null);

    // 关联中状态
    const [switching, setSwitching] = useState(false);

    // 防止过时响应覆盖新搜索
    const searchIdRef = useRef(0);

    const tabItems = useMemo(
        () => plugins.map((p) => ({ key: p.hash, label: p.platform })),
        [plugins],
    );

    /** 执行搜索 */
    const doSearch = useCallback(
        (searchQuery: string) => {
            if (!searchQuery.trim() || plugins.length === 0) return;

            const searchId = ++searchIdRef.current;

            // 所有插件置为 loading
            const initialResults: Record<string, PluginSearchResult> = {};
            for (const plugin of plugins) {
                initialResults[plugin.hash] = { loading: true, data: [] };
            }
            setResults(initialResults);

            // 并行搜索所有插件
            for (const plugin of plugins) {
                pluginManager
                    .callPluginMethod({
                        hash: plugin.hash,
                        method: 'search',
                        args: [searchQuery.trim(), 1, 'music'],
                    })
                    .then((result) => {
                        if (searchIdRef.current !== searchId) return;
                        setResults((prev) => ({
                            ...prev,
                            [plugin.hash]: {
                                loading: false,
                                data: (result?.data as IMusic.IMusicItem[]) ?? [],
                            },
                        }));
                    })
                    .catch(() => {
                        if (searchIdRef.current !== searchId) return;
                        setResults((prev) => ({
                            ...prev,
                            [plugin.hash]: { loading: false, data: [], error: true },
                        }));
                    });
            }
        },
        [plugins],
    );

    // 打开时读取已关联音源并自动搜索
    const initialSetupDone = useRef(false);
    useEffect(() => {
        if (initialSetupDone.current) return;
        initialSetupDone.current = true;

        mediaMeta
            .getMeta(musicItem.platform, String(musicItem.id))
            .then((meta) => setLinkedItem(meta?.associatedSource ?? null))
            .catch(() => {});

        if (defaultQuery) {
            doSearch(defaultQuery);
        }
    }, [defaultQuery, doSearch, musicItem]);

    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Enter') {
                doSearch(query);
            }
        },
        [doSearch, query],
    );

    /** 点击搜索结果，关联音源并在当前播放时即时换流 */
    const handleSelectSource = useCallback(
        async (target: IMusic.IMusicItem) => {
            if (switching) return;

            setSwitching(true);
            try {
                await mediaMeta.setMeta(musicItem.platform, String(musicItem.id), {
                    associatedSource: target,
                });

                if (currentMusic && isSameMedia(currentMusic, musicItem)) {
                    const ok = await trackPlayer.refreshCurrentSource();
                    if (!ok) {
                        showToast(t('switch_source.failed'), { type: 'warn' });
                        return;
                    }
                }

                showToast(t('switch_source.success'));
                close();
            } catch {
                showToast(t('switch_source.failed'), { type: 'warn' });
            } finally {
                setSwitching(false);
            }
        },
        [switching, musicItem, currentMusic, close, t],
    );

    const activeResult = results[activePluginKey];

    // 将插件搜索状态映射为 RequestStatus
    const resultStatus = !activeResult
        ? RequestStatus.Idle
        : activeResult.loading
          ? RequestStatus.Pending
          : activeResult.error
            ? RequestStatus.Error
            : RequestStatus.Done;

    return (
        <Modal open onClose={close} title={t('switch_source.title')} size="lg">
            <div className="b-switch-source-modal">
                {/* 搜索栏 */}
                <div className="b-switch-source-modal__search-bar">
                    <Input
                        prefix={<Search size={16} />}
                        placeholder={t('switch_source.search_placeholder')}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={handleKeyDown}
                        allowClear
                        onClear={() => setQuery('')}
                        autoFocus
                    />
                </div>

                {/* 插件 Tab */}
                {plugins.length > 0 && (
                    <TabBar
                        items={tabItems}
                        activeKey={activePluginKey}
                        onChange={setActivePluginKey}
                        className="b-switch-source-modal__tabs"
                    />
                )}

                {/* 搜索结果 */}
                <ScrollArea className="b-switch-source-modal__results">
                    {plugins.length === 0 ? (
                        <StatusPlaceholder
                            status={RequestStatus.Done}
                            isEmpty
                            emptyTitle={t('switch_source.no_plugin')}
                        />
                    ) : (
                        <>
                            <StatusPlaceholder
                                status={resultStatus}
                                isEmpty={activeResult?.data.length === 0}
                                emptyTitle={t('switch_source.no_result')}
                                errorTitle={t('switch_source.search_failed')}
                                onRetry={() => doSearch(query)}
                            />
                            {resultStatus === RequestStatus.Done &&
                                (activeResult?.data ?? []).map((item, index) => {
                                    const isLinked =
                                        isSameMedia(item, linkedItem) ||
                                        isSameMedia(item, musicItem);
                                    return (
                                        <button
                                            key={`${item.platform}-${item.id}-${index}`}
                                            type="button"
                                            className="b-switch-source-modal__item"
                                            disabled={switching}
                                            onClick={() => handleSelectSource(item)}
                                        >
                                            <Artwork src={item.artwork} size="sm" rounded="sm" />
                                            <div className="b-switch-source-modal__item-info">
                                                <div className="b-switch-source-modal__item-title">
                                                    <span>{item.title}</span>
                                                    {isLinked && (
                                                        <Check
                                                            size={14}
                                                            className="b-switch-source-modal__item-check"
                                                        />
                                                    )}
                                                </div>
                                                <div className="b-switch-source-modal__item-artist">
                                                    <span>{item.artist ?? '--'}</span>
                                                    {item.album ? (
                                                        <>
                                                            <span className="b-switch-source-modal__item-divider">
                                                                ·
                                                            </span>
                                                            <span>{item.album}</span>
                                                        </>
                                                    ) : null}
                                                </div>
                                            </div>
                                            <div className="b-switch-source-modal__item-meta">
                                                <span className="b-switch-source-modal__item-platform">
                                                    {item.platform}
                                                </span>
                                                {item.duration ? (
                                                    <span className="b-switch-source-modal__item-duration">
                                                        {formatDuration(item.duration)}
                                                    </span>
                                                ) : null}
                                            </div>
                                        </button>
                                    );
                                })}
                        </>
                    )}
                </ScrollArea>
            </div>
        </Modal>
    );
}
