// ==UserScript==
// @name         即梦 & Dreamina 图片/视频下载器
// @namespace    http://tampermonkey.net/
// @version      1.0.1
// @description  一键下载即梦AI图片/视频。自动拦截API响应获取无水印原图，支持图片/视频详情页和列表页。
// @author       Daniel Song
// @match        https://jimeng.jianying.com/*
// @match        https://dreamina.capcut.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      *
// @noframes
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    // ========================================
    // 配置
    // ========================================
    const CONFIG = {
        DEBUG: true,
        BATCH_DELAY: 600,
        MAX_RETRIES: 2,
        SCAN_INTERVAL: 2000,
        // API 白名单域名（只拦截这些域名的请求）
        API_HOSTS: [
            'jianying.com',
            'capcut.com',
            'douyin.com',
            'bytedance.com'
        ],
        // CDN 域名白名单（支持即梦和剪映的所有 CDN）
        CDN_PATTERNS: [
            'byteimg.com',
            'vlabstatic.com',
            'vlabvod.com',
            'douyin.com',
            'byted-static.net',
            'pstatp.com',
            'ixigua.com',
            'ibytedtos.com',   // Dreamina 用户头像/资源 CDN
            'lf3-capsule.vlabstatic.com',
            'lf6-capsule.vlabstatic.com'
        ],
        // 优先尝试的高清尺寸
        PREFERRED_SIZES: [2048, 1920, 1080, 900],
        // 关注的 API 路径
        INTERESTING_PATHS: [
            'get_user_local_item_list',
            'get_explore',
            'feed',
            'item_list',
            'video_info',
            'image_info'
        ]
    };

    const log = {
        i: (...a) => CONFIG.DEBUG && console.log('[下⭮]', ...a),
        e: (...a) => console.error('[下⭮错]', ...a),
        w: (...a) => console.warn('[下⭮警]', ...a)
    };

    // ========================================
    // 状态
    // ========================================
    const S = {
        // 从 API 拦截到的资源
        resources: [],      // { url, id, type: 'image'|'video', quality, timestamp }
        // 正在下载
        downloading: false,
        // 是否已初始化完成
        ready: false,
        // 拦截计数
        interceptedCount: 0
    };

    // ========================================
    // 工具
    // ========================================
    const U = {
        sleep: ms => new Promise(r => setTimeout(r, ms)),

        getExt(url) {
            if (!url) return 'png';
            // 优先从 mime_type 参数提取（视频 CDN URL 无文件扩展名）
            const mimeMatch = url.match(/mime_type=video_(\w+)/i);
            if (mimeMatch) {
                const t = mimeMatch[1].toLowerCase();
                if (t === 'mp4') return 'mp4';
                if (t === 'webm') return 'webm';
                if (t === 'quicktime') return 'mov';
            }
            const m = url.match(/\.(png|jpg|jpeg|webp|gif|mp4|webm|mov)(\?|$|#|$)/i);
            return m ? m[1].toLowerCase() : 'png';
        },

        isVideo(url) {
            if (!url) return false;
            // 1. 直接文件扩展名
            if (/\.(mp4|webm|mov)(\?|$|#)/i.test(url)) return true;
            // 2. mime_type=video_mp4 / video_webm（vlabvod.com 等视频 CDN 的 URL 参数格式）
            if (/mime_type=video_(mp4|webm|mov)/i.test(url)) return true;
            // 3. ByteDance 视频 CDN 路径：/video/ 目录
            if (/\/video\/tos\//i.test(url)) return true;
            // 4. obj/video、obj/videodb 等路径
            if (/\/obj\/(video|videodb|bytedance)/i.test(url)) return true;
            return false;
        },

        isCDNUrl(url) {
            if (!url || typeof url !== 'string') return false;
            if (!url.startsWith('http')) return false;
            // 排除明显不是资源的外链域名
            const skipDomains = [
                'google.com', 'googleapis.com', 'googleadservices.com',
                'doubleclick.net', 'googlesyndication.com',
                'facebook.com', 'fbcdn.net', 'instagram.com',
                'twitter.com', 'x.com', 't.co',
                'baidu.com', 'bdstatic.com',
                'aliyun.com', 'alipay.com', 'alibaba.com',
                'amazonaws.com', 'cloudfront.net',
                'segment.com', 'mixpanel.com', 'amplitude.com',
                'hotjar.com', 'fullstory.com',
                'sentry.io', 'bugsnag.com',
                'intercom.io', 'zendesk.com', 'crisp.chat',
                'youtube.com', 'ytimg.com', 'googlevideo.com',
                'vimeo.com',
                'github.com', 'githubusercontent.com',
                'cdn.cookielaw.org', 'privacy-mgmt.com',
                'onesignal.com', 'pushwoosh.com',
                'amplitude', 'segment', 'mixpanel',
            ];
            try {
                const u2 = new URL(url);
                const host = u2.hostname.toLowerCase();
                if (skipDomains.some(d => host.includes(d))) return false;
            } catch {}

            // 标准 CDN 域名
            if (CONFIG.CDN_PATTERNS.some(p => url.includes(p))) return true;
            // ByteDance 视频 CDN 路径
            if (/\/obj\/(video|videodb|bytedance)/i.test(url)) return true;
            // 包含媒体路径关键词
            if (/\/(obj|video|image|img|media|asset|tos-cn|thumb|bucket|cover|preview)\//i.test(url)) return true;
            // ByteDance 特有 URL 后缀
            if (url.includes('~tplv') || url.includes('~cbpeditor')) return true;
            // 直接文件扩展名（常见媒体格式）
            if (/\.(png|jpg|jpeg|webp|gif|mp4|webm|mov|avi|mkv)(\?|&|$|#)/i.test(url)) return true;
            // 包含 mime_type=video_ 参数
            if (/mime_type=video_/i.test(url)) return true;
            // 包含常见的 CDN 签名参数
            if (/(&|\?)lk3s=/.test(url) || /(&|\?)x-expires=/.test(url) || /(&|\?)x-signature=/.test(url)) return true;
            // 来自 Dreamina/CapCut API 的资源 URL
            if (url.includes('dreamina-api.') || url.includes('.capcut.com') || url.includes('.bytedance.com')) {
                // 有路径参数包含数字 ID 的，大概率是资源 URL
                if (/\/([\w-]+)\?.*(token|key|sign|auth|bid|a_bogus|lk3s)=/i.test(url)) return true;
            }
            return false;
        },

        // 提取资源 ID（图片/视频通用）
        extractResourceId(url) {
            if (!url) return null;
            // 格式: .../tos-cn-i-{bucket}/{resource_id}~tplv-...
            const m = url.match(/tos-cn-i-[^/]+\/([^~]+)/);
            if (m) return m[1];
            // 备选：直接取路径最后一段（去掉查询参数）
            try {
                const u = new URL(url);
                const parts = u.pathname.split('/').filter(Boolean);
                return parts[parts.length - 1].split('~')[0];
            } catch {
                return null;
            }
        },

        // 从 URL 提取质量分数
        getQualityFromUrl(url) {
            if (!url) return 0;
            if (url.includes('aigc_resize:0:0')) return 9999;
            if (url.includes('aigc_resize_loss')) return 100;
            if (url.includes('aigc_smart_crop')) return 50;
            if (url.includes('_2048.')) return 2048;
            if (url.includes('_1920.')) return 1920;
            if (url.includes('_1080.')) return 1080;
            if (url.includes('_900.')) return 900;
            if (url.includes('_720.')) return 720;
            const m = url.match(/resize:(\d+):(\d+)/);
            if (m) return Math.max(parseInt(m[1]), parseInt(m[2]));
            return 100;
        },

        // URL 去重
        dedupeUrl(url) {
            // 去掉签名参数，提取基础 URL 用于去重
            try {
                const u = new URL(url);
                // 保留必要的参数，去掉动态签名
                const base = u.origin + u.pathname;
                const params = {};
                for (const [k, v] of u.searchParams) {
                    if (['lk3s', 'x-expires', 'x-signature', 'a_bogus'].includes(k)) continue;
                    params[k] = v;
                }
                const q = new URLSearchParams(params).toString();
                return q ? `${base}?${q}` : base;
            } catch {
                return url;
            }
        },

        // 下载文件
        async download(url, filename, retries = 0) {
            const ext = this.getExt(url);
            const name = filename.includes('.') ? filename : `${filename}.${ext}`;
            console.log('[下⭮ 开始下载]', name, '\nURL:', url);
            log.i('下载:', name, url.substring(0, 100));

            return new Promise((resolve, reject) => {
                const referer = url.includes('dreamina') || url.includes('capcut')
                    ? 'https://dreamina.capcut.com/'
                    : url.includes('vlabvod.com')
                        ? 'https://jimeng.jianying.com/'
                        : 'https://jimeng.jianying.com/';

                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    responseType: 'blob',
                    headers: {
                        'Referer': referer,
                        'Origin': referer,
                        'Accept': 'image/*,video/*,*/*'
                    },
                    onload(resp) {
                        log.i(`响应状态: ${resp.status} (${url.substring(0, 60)})`);
                        if (resp.status === 200) {
                            const blob = resp.response;
                            if (!blob || blob.size === 0) {
                                reject(new Error('空响应体'));
                                return;
                            }
                            const a = document.createElement('a');
                            a.href = URL.createObjectURL(blob);
                            a.download = name;
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(a.href), 10000);
                            resolve(name);
                        } else if (resp.status === 403 || resp.status === 404 || resp.status === 401) {
                            // URL 可能过期，尝试去掉签名参数重试
                            if (retries < CONFIG.MAX_RETRIES) {
                                const cleanUrl = U.stripSignature(url);
                                if (cleanUrl !== url) {
                                    log.w('URL 过期，尝试无签名版本...');
                                    U.download.call(U, cleanUrl, name, retries + 1).then(resolve).catch(reject);
                                    return;
                                }
                            }
                            reject(new Error(`HTTP ${resp.status} — URL 可能已过期`));
                        } else {
                            reject(new Error(`HTTP ${resp.status}`));
                        }
                    },
                    onerror: (resp) => {
                        log.e('下载失败！详情:', {
                            status: resp?.status,
                            statusText: resp?.statusText,
                            response: resp?.response ? resp.response.substring(0, 200) : null,
                            finalUrl: resp?.finalUrl,
                            error: resp?.error
                        });
                        reject(new Error(`网络错误 (HTTP ${resp?.status || '?'}): ${resp?.statusText || resp?.error || ''}`));
                    },
                    ontimeout: () => reject(new Error('超时'))
                });
            });
        },

        // 去掉动态签名参数，提取可用的基础 URL
        stripSignature(url) {
            try {
                const u = new URL(url);
                // 保留关键参数，去掉可能过期的签名
                const keepParams = ['lk3s'];  // 只保留 lk3s
                const params = new URLSearchParams();
                for (const [k, v] of u.searchParams) {
                    if (keepParams.includes(k)) params.set(k, v);
                }
                const q = params.toString();
                return q ? `${u.origin}${u.pathname}?${q}` : `${u.origin}${u.pathname}`;
            } catch {
                return url;
            }
        },

        // 批量下载
        async downloadAll(items) {
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                try {
                    await this.download(item.url, item.filename || `即梦_${item.id}`);
                    if (i < items.length - 1) {
                        await this.sleep(CONFIG.BATCH_DELAY);
                    }
                } catch(e) {
                    log.e(`下载失败 ${item.url}:`, e);
                }
            }
        }
    };

    // ========================================
    // API 拦截器 — 在页面加载前就注入拦截逻辑
    // ========================================
    const apiInterceptor = {
        originalFetch: null,
        originalXHROpen: null,
        originalXHRSend: null,
        pendingRequests: new Map(),

        init() {
            // 拦截 fetch
            this.originalFetch = window.fetch;
            const self = this;
            window.fetch = function(...args) {
                return self.handleFetch(this, ...args);
            };

            // 拦截 XMLHttpRequest.open
            this.originalXHROpen = window.XMLHttpRequest.prototype.open;
            const self2 = this;
            window.XMLHttpRequest.prototype.open = function(method, url, ...rest) {
                this._jmg_url = typeof url === 'string' ? url : '';
                return self2.originalXHROpen.call(this, method, url, ...rest);
            };

            // 拦截 XMLHttpRequest.send
            this.originalXHRSend = window.XMLHttpRequest.prototype.send;
            window.XMLHttpRequest.prototype.send = function(...args) {
                return self2.handleXHRSend(this, ...args);
            };

            log.i('API 拦截器初始化完成');
        },

isInterestingRequest(url) {
            if (!url) return false;
            try {
                const u = new URL(url, location.href);
                const host = u.hostname;
                // capcut.com / dreamina.capcut.com 域名：拦截所有跨域请求（大概率是 API）
                const isCapcut = host.includes('capcut.com') || host.includes('bytedance.com');
                if (isCapcut) return true;
                // jianying.com / douyin.com：必须在白名单主机上
                const hostOk = CONFIG.API_HOSTS.some(h => host.includes(h));
                if (!hostOk) return false;
                // 必须是 /mweb/ 或 /api/ 路径
                const path = u.pathname;
                return path.includes('/mweb/') || path.includes('/api/') || path.includes('/v1/');
            } catch {
                return false;
            }
        },

        async handleFetch(ctx, ...args) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url);
            const isInteresting = this.isInterestingRequest(url);

            if (isInteresting) {
                log.i('[Fetch 拦截]', url);
                S.interceptedCount++;
            }

            try {
                const response = await this.originalFetch.apply(ctx, args);

                if (isInteresting) {
                    // 克隆响应，读取 body
                    try {
                        const clone = response.clone();
                        const text = await clone.text();
                        this.parseResponse(url, text);
                    } catch(e) {
                        log.w('读取响应失败:', e);
                    }
                }

                return response;
            } catch(e) {
                return Promise.reject(e);
            }
        },

        handleXHRSend(xhr, ...args) {
            const url = xhr._jmg_url;
            const isInteresting = this.isInterestingRequest(url);

            if (isInteresting) {
                log.i('[XHR 拦截]', url);
                S.interceptedCount++;
            }

            // 监听响应
            const self = this;
            xhr.addEventListener('load', function() {
                if (isInteresting && xhr.responseText) {
                    self.parseResponse(url, xhr.responseText);
                }
            });

            return this.originalXHRSend.apply(xhr, args);
        },

        // 从响应文本解析资源 URL
        parseResponse(url, text) {
            try {
                const data = JSON.parse(text);
                this.extractResources(data);
            } catch(e) {
                log.w('JSON 解析失败:', e);
            }
        },

        // 从响应数据中递归提取 CDN URL
        extractResources(obj, depth = 0) {
            if (depth > 15 || !obj || typeof obj !== 'object') return;

            if (Array.isArray(obj)) {
                obj.forEach(item => this.extractResources(item, depth + 1));
                return;
            }

            for (const [key, value] of Object.entries(obj)) {
                // 跳过超长文本字段，避免无谓扫描
                if (typeof value === 'string' && value.length > 20000) continue;
                if (typeof value === 'string' && U.isCDNUrl(value)) {
                    this.handleFoundUrl(value, key);
                } else if (typeof value === 'object' && value !== null) {
                    this.extractResources(value, depth + 1);
                }
            }
        },

        handleFoundUrl(url, sourceKey = '', el = null) {
            // 去重
            const dedupe = U.dedupeUrl(url);
            if (S.resources.some(r => r.dedupe === dedupe)) return;

            const isVideo = U.isVideo(url);
            const quality = isVideo ? 0 : U.getQualityFromUrl(url);

            // 过滤：图片低于 1080px 视为 UI 图标/非生成内容
            if (!isVideo && quality < 1080) {
                return;
            }

            const id = U.extractResourceId(url) || (isVideo ? `video_${Date.now()}` : `img_${Date.now()}`);

            S.resources.push({
                url,
                id,
                type: isVideo ? 'video' : 'image',
                quality,
                dedupe,
                source: sourceKey,
                el: el,   // DOM 元素引用，用于缩略图
                timestamp: Date.now()
            });

            log.i(`发现资源: ${isVideo ? '📹' : '🖼'} [${sourceKey}] ${id} (${quality}px)`);
            log.i(`  URL: ${url.substring(0, 120)}`);
            ui.updateButton();
        }
    };

    // ========================================
    // DOM 扫描器 — MutationObserver + 定时扫描
    // ========================================
    const scanner = {
        observedEls: new Set(),

        init() {
            // 初始扫描
            setTimeout(() => this.scan(), 1500);
            setTimeout(() => this.scan(), 4000);

            // MutationObserver 持续监控
            this.startObserver();

            // 定时扫描兜底
            setInterval(() => this.scan(), CONFIG.SCAN_INTERVAL);
        },

        scan() {
            // 扫描 img
            document.querySelectorAll('img[src]').forEach(el => this.processImg(el));
            // 扫描 video source
            document.querySelectorAll('video source[src]').forEach(el => this.processVideoSrc(el));
            // 扫描 video[src]
            document.querySelectorAll('video[src]').forEach(el => this.processVideoSrc(el));
            // 扫描 video poster（视频封面图）
            document.querySelectorAll('video[poster]').forEach(el => this.processPoster(el));
            // 扫描 a[data-url] / div[data-src] 等 data 属性中的 URL
            this.scanDataAttributes();
            // 深度扫描：所有 video 元素（包括无 src 属性但有 source 子元素的）
            this.scanVideoElements();
        },

        // 深度扫描所有 video 元素，捕获 currentSrc / source 子节点 / HLS 流 URL
        scanVideoElements() {
            document.querySelectorAll('video').forEach(video => {
                // 1. currentSrc（JS 动态设置的 src）
                const currentSrc = video.currentSrc;
                if (currentSrc && currentSrc.startsWith('http')) {
                    this.processVideoSrc({ src: currentSrc, _jmgScanned: false, parentElement: video });
                }
                // 2. HLS / DASH manifest URL（在 src 属性中）
                const src = video.src;
                if (src && (src.includes('.m3u8') || src.includes('.mpd') || U.isVideo(src))) {
                    this.processVideoSrc({ src: src, _jmgScanned: false, parentElement: video });
                }
                // 3. source 子元素的 src
                video.querySelectorAll('source[src]').forEach(el => {
                    this.processVideoSrc({ src: el.src, _jmgScanned: false, parentElement: video });
                });
            });
        },

        processPoster(videoEl) {
            if (videoEl._jmgPosterScanned) return;
            videoEl._jmgPosterScanned = true;
            const url = videoEl.getAttribute('poster');
            if (!U.isCDNUrl(url)) return;
            const dedupe = U.dedupeUrl(url);
            if (S.resources.some(r => r.dedupe === dedupe)) return;
            S.resources.push({
                url,
                id: U.extractResourceId(url) || `poster_${Date.now()}`,
                type: 'image',
                quality: U.getQualityFromUrl(url),
                dedupe,
                el: videoEl,
                timestamp: Date.now()
            });
            log.i(`[DOM] 🖼 video poster: ${url.substring(0, 80)}`);
            ui.updateButton();
        },

        scanDataAttributes() {
            if (document._jmgDataAttrScanned) return;
            document._jmgDataAttrScanned = true;

            // 扫描 data-* 属性中包含 CDN URL 的元素
            const els = document.querySelectorAll('[data-url],[data-src],[data-video],[data-href]');
            els.forEach(el => {
                ['data-url', 'data-src', 'data-video', 'data-href'].forEach(attr => {
                    const val = el.getAttribute(attr);
                    if (!val || !U.isCDNUrl(val)) return;
                    if (U.isVideo(val)) {
                        this.processVideoSrc({ src: val, _jmgScanned: false, parentElement: el });
                    } else {
                        this.processImg({ src: val, _jmgScanned: false });
                    }
                });
            });
        },

        processImg(img) {
            if (img._jmgScanned) return;
            img._jmgScanned = true;

            const url = img.src;
            if (!U.isCDNUrl(url)) return;

            const id = U.extractResourceId(url);
            const quality = U.getQualityFromUrl(url);
            const dedupe = U.dedupeUrl(url);

            if (S.resources.some(r => r.dedupe === dedupe)) return;
            if (quality < 1080) return; // 过滤低分辨率图标

            S.resources.push({
                url,
                id: id || `img_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                type: 'image',
                quality,
                dedupe,
                el: img,  // 保留 DOM 引用，用于缩略图
                timestamp: Date.now()
            });

            log.i(`[DOM] 🖼 img: ${id} (${quality}px)`);
            ui.updateButton();
        },

        processVideoSrc(el) {
            if (el._jmgScanned) return;
            el._jmgScanned = true;

            const url = el.src;
            if (!U.isCDNUrl(url) || !U.isVideo(url)) return;

            const dedupe = U.dedupeUrl(url);
            if (S.resources.some(r => r.dedupe === dedupe)) return;

            S.resources.push({
                url,
                id: `video_${Date.now()}_${Math.random().toString(36).slice(2)}`,
                type: 'video',
                quality: 0,
                dedupe,
                el: el.parentElement || el,
                timestamp: Date.now()
            });

            log.i(`[DOM] 📹 video src: ${url.substring(0, 80)}`);
            ui.updateButton();
        },

        startObserver() {
            const obs = new MutationObserver(mutations => {
                let hasNew = false;
                for (const mut of mutations) {
                    if (mut.addedNodes.length > 0) {
                        hasNew = true;
                        break;
                    }
                }
                if (hasNew) {
                    clearTimeout(this._t);
                    this._t = setTimeout(() => this.scan(), 800);
                }
            });

            obs.observe(document.body, { childList: true, subtree: true });
            log.i('MutationObserver 启动');
        }
    };

    // ========================================
    // UI
    // ========================================
    const ui = {
        btn: null,
        panel: null,
        toastTimer: null,

        init() {
            this.injectStyles();
            this.createButton();
            this.createPanel();
            this.createHint();
            log.i('UI 初始化完成');
        },

        injectStyles() {
            GM_addStyle(`
                #jmg-btn {
                    position: fixed; bottom: 24px; right: 24px; z-index: 9999999;
                    display: flex; align-items: center; gap: 8px;
                    padding: 10px 20px;
                    background: linear-gradient(135deg, #007AFF, #5856D6);
                    color: white; border: none; border-radius: 24px;
                    cursor: pointer; font-size: 14px; font-weight: 600;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    box-shadow: 0 4px 20px rgba(0,122,255,0.4);
                    transition: transform 0.2s, box-shadow 0.2s;
                    user-select: none;
                }
                #jmg-btn:hover { transform: translateY(-1px); box-shadow: 0 6px 24px rgba(0,122,255,0.5); }
                #jmg-btn:active { transform: scale(0.97); }
                #jmg-btn.has-images { animation: jmg-pulse 2s ease-in-out infinite; }
                @keyframes jmg-pulse {
                    0%,100% { box-shadow: 0 4px 20px rgba(0,122,255,0.4); }
                    50% { box-shadow: 0 4px 30px rgba(0,122,255,0.8); }
                }
                #jmg-badge {
                    background: white; color: #007AFF; border-radius: 10px;
                    padding: 1px 8px; font-size: 12px; font-weight: 700;
                }
                #jmg-panel {
                    position: fixed; bottom: 80px; right: 24px; z-index: 9999999;
                    width: 340px; max-height: 480px;
                    background: #1c1c1e; color: white;
                    border-radius: 16px; overflow: hidden;
                    box-shadow: 0 8px 40px rgba(0,0,0,0.5);
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                    display: none; flex-direction: column;
                    border: 1px solid rgba(255,255,255,0.1);
                }
                #jmg-panel.open { display: flex; }
                #jmg-panel-header {
                    padding: 14px 16px 10px;
                    border-bottom: 1px solid rgba(255,255,255,0.08);
                    display: flex; align-items: center; justify-content: space-between;
                }
                #jmg-panel-title { font-size: 14px; font-weight: 600; }
                #jmg-panel-count { font-size: 12px; color: #8e8e93; }
                #jmg-panel-close {
                    background: none; border: none; color: #8e8e93; cursor: pointer;
                    font-size: 18px; padding: 0 4px; line-height: 1;
                }
                #jmg-panel-close:hover { color: white; }
                #jmg-panel-body {
                    flex: 1; overflow-y: auto; padding: 8px 0;
                    max-height: 380px;
                }
                #jmg-panel-body::-webkit-scrollbar { width: 4px; }
                #jmg-panel-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 2px; }
                .jmg-item {
                    display: flex; align-items: center; gap: 10px;
                    padding: 8px 16px; cursor: pointer;
                    transition: background 0.15s;
                }
                .jmg-item:hover { background: rgba(255,255,255,0.06); }
                .jmg-item-icon {
                    width: 40px; height: 40px; border-radius: 8px;
                    object-fit: cover; background: #2c2c2e; flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center;
                    font-size: 18px;
                }
                .jmg-item-icon img { width: 100%; height: 100%; border-radius: 8px; object-fit: cover; }
                .jmg-item-info { flex: 1; min-width: 0; }
                .jmg-item-id { font-size: 12px; color: #8e8e93; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
                .jmg-item-quality { font-size: 11px; color: #007AFF; margin-top: 2px; }
                .jmg-item-download {
                    width: 32px; height: 32px; border: none; border-radius: 8px;
                    background: rgba(0,122,255,0.2); cursor: pointer; flex-shrink: 0;
                    display: flex; align-items: center; justify-content: center;
                    color: #007AFF; transition: background 0.15s;
                }
                .jmg-item-download:hover { background: #007AFF; color: white; }
                #jmg-panel-footer {
                    padding: 10px 16px; border-top: 1px solid rgba(255,255,255,0.08);
                    display: flex; gap: 8px;
                }
                #jmg-download-all {
                    flex: 1; padding: 8px;
                    background: linear-gradient(135deg, #007AFF, #5856D6);
                    color: white; border: none; border-radius: 10px;
                    cursor: pointer; font-size: 13px; font-weight: 600;
                    font-family: inherit;
                    transition: opacity 0.2s;
                }
                #jmg-download-all:hover { opacity: 0.9; }
                #jmg-download-all:disabled { opacity: 0.4; cursor: not-allowed; }
                #jmg-clear {
                    padding: 8px 12px;
                    background: rgba(255,255,255,0.08); color: #8e8e93;
                    border: none; border-radius: 10px; cursor: pointer;
                    font-size: 13px; font-family: inherit;
                }
                #jmg-clear:hover { background: rgba(255,59,48,0.2); color: #FF3B30; }
                #jmg-refresh {
                    padding: 8px 12px;
                    background: rgba(0,122,255,0.15); color: #007AFF;
                    border: none; border-radius: 10px; cursor: pointer;
                    font-size: 13px; font-family: inherit; display: flex; align-items: center; gap: 4px;
                    transition: background 0.2s;
                }
                #jmg-refresh:hover { background: rgba(0,122,255,0.3); }
                #jmg-refresh:active { transform: scale(0.97); }
                #jmg-toast {
                    position: fixed; bottom: 80px; right: 24px; z-index: 10000000;
                    padding: 12px 20px; background: #333; color: white;
                    border-radius: 8px; font-size: 13px;
                    font-family: -apple-system, sans-serif;
                    opacity: 0; transform: translateY(8px);
                    transition: all 0.3s; pointer-events: none;
                }
                #jmg-toast.show { opacity: 1; transform: translateY(0); }
                #jmg-toast.ok { background: linear-gradient(135deg, #34C759, #30D158); }
                #jmg-toast.err { background: linear-gradient(135deg, #FF3B30, #FF453A); }
                #jmg-hint {
                    position: fixed; bottom: 24px; left: 24px; z-index: 9999998;
                    padding: 10px 16px; background: rgba(0,0,0,0.75); color: rgba(255,255,255,0.9);
                    border-radius: 8px; font-size: 12px; font-family: -apple-system,sans-serif;
                    backdrop-filter: blur(8px); line-height: 1.8;
                    max-width: 240px;
                }
            `);
        },

        createButton() {
            const btn = document.createElement('button');
            btn.id = 'jmg-btn';
            btn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
                <span>下载</span>
                <span id="jmg-badge" style="display:none">0</span>
            `;
            btn.addEventListener('click', () => this.togglePanel());
            document.body.appendChild(btn);
            this.btn = btn;
        },

        createPanel() {
            const panel = document.createElement('div');
            panel.id = 'jmg-panel';
            panel.innerHTML = `
                <div id="jmg-panel-header">
                    <span id="jmg-panel-title">发现资源</span>
                    <span id="jmg-panel-count">0 个</span>
                    <button id="jmg-panel-close">×</button>
                </div>
                <div id="jmg-panel-body"></div>
                <div id="jmg-panel-footer">
                    <button id="jmg-refresh" title="重新扫描页面" style="padding:8px 12px;background:rgba(0,122,255,0.2);color:#007AFF;border:none;border-radius:10px;cursor:pointer;font-size:13px;font-family:inherit;display:flex;align-items:center;gap:4px;">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="flex-shrink:0">
                            <polyline points="23 4 23 10 17 10"/>
                            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                        </svg>
                        刷新
                    </button>
                    <button id="jmg-download-all" style="flex:1">下载全部</button>
                    <button id="jmg-clear" style="padding:8px 12px;background:rgba(255,255,255,0.08);color:#8e8e93;border:none;border-radius:10px;cursor:pointer;font-size:13px;font-family:inherit;">清空</button>
                </div>
            `;
            document.body.appendChild(panel);

            document.getElementById('jmg-panel-close').addEventListener('click', () => this.closePanel());
            document.getElementById('jmg-download-all').addEventListener('click', () => this.downloadAll());
            document.getElementById('jmg-clear').addEventListener('click', () => this.clearResources());
            document.getElementById('jmg-refresh').addEventListener('click', () => {
                // 清空已有资源，重新扫描，只保留新发现的
                S.resources = [];
                ui.updateButton();
                scanner.scan();
                this.toast('正在扫描...');
                setTimeout(() => {
                    const n = S.resources.length;
                    this.toast(`扫描完成，共 ${n} 个资源`, n > 0 ? 'ok' : '');
                }, 1500);
            });

            this.panel = panel;
        },

        createHint() {
            const hint = document.createElement('div');
            hint.id = 'jmg-hint';
            hint.innerHTML = `
                <b style="font-size:13px;color:#0A84FF">即梦下载器 v1.0.0</b><br>
                拦截 API 响应自动发现资源<br>
                点击右下角按钮查看和下载
            `;
            document.body.appendChild(hint);
            setTimeout(() => {
                hint.style.opacity = '0';
                hint.style.transition = 'opacity 2s';
                setTimeout(() => hint.remove(), 2100);
            }, 6000);
        },

        updateButton() {
            if (!this.btn) return;
            const n = S.resources.length;
            const badge = document.getElementById('jmg-badge');
            if (n > 0) {
                this.btn.classList.add('has-images');
                if (badge) { badge.style.display = 'inline'; badge.textContent = n > 99 ? '99+' : n; }
            } else {
                this.btn.classList.remove('has-images');
                if (badge) badge.style.display = 'none';
            }
            this.updatePanel();
        },

        updatePanel() {
            if (!this.panel) return;
            const body = document.getElementById('jmg-panel-body');
            const count = document.getElementById('jmg-panel-count');
            if (!body) return;

            // 去重
            const seen = new Set();
            const all = S.resources.filter(r => {
                if (seen.has(r.dedupe)) return false;
                seen.add(r.dedupe);
                return true;
            });

            const images = all.filter(r => r.type === 'image').sort((a, b) => b.quality - a.quality);
            const videos = all.filter(r => r.type === 'video');  // 视频在前，图片在后

            count.textContent = `${videos.length} 视频 · ${images.length} 图`;

            body.innerHTML = '';

            // 渲染单个资源项
            const renderItem = (r) => {
                const item = document.createElement('div');
                item.className = 'jmg-item';

                // 缩略图：优先用页面上已加载的真实图片/封面
                let thumbContent = '';
                let thumbStyle = '';

                if (r.type === 'image') {
                    // 图片：尝试用 DOM 元素的 src（页面上已加载，无 CORS 问题）
                    const imgEl = r.el && r.el.tagName === 'IMG' ? r.el : null;
                    const thumbUrl = imgEl && imgEl.src && imgEl.src.startsWith('http') ? imgEl.src : null;
                    if (thumbUrl) {
                        // 缩略图用页面已渲染的 img.src（已解决 CORS），下载用高质量 URL
                        thumbContent = `<img src="${thumbUrl}" style="width:100%;height:100%;border-radius:8px;object-fit:cover;" crossorigin="anonymous" onerror="this.parentElement.style.background='linear-gradient(135deg,#007AFF,#5856D6)';this.style.display='none'">`;
                        thumbStyle = '';
                    } else {
                        const shortId = r.id.substring(0, 8);
                        thumbContent = `<span style="color:white;font-size:10px;font-weight:600;font-family:monospace;letter-spacing:0.5px;word-break:break-all;padding:4px;">${shortId}</span>`;
                        thumbStyle = 'background: linear-gradient(135deg, #007AFF, #5856D6);';
                    }
                } else {
                    // 视频：尝试用 video.poster
                    const videoEl = r.el && r.el.tagName === 'VIDEO' ? r.el : null;
                    const posterUrl = videoEl && videoEl.poster ? videoEl.poster : null;
                    if (posterUrl) {
                        thumbContent = `<img src="${posterUrl}" style="width:100%;height:100%;border-radius:8px;object-fit:cover;" crossorigin="anonymous" onerror="this.parentElement.style.background='linear-gradient(135deg,#667eea,#764ba2)';this.style.display='none'">`;
                    } else {
                        thumbContent = `<span style="color:white;font-size:18px;">📹</span>`;
                        thumbStyle = 'background: linear-gradient(135deg, #667eea, #764ba2);';
                    }
                }

                const qualityLabel = r.type === 'video' ? '📹 视频' : `🖼 ${r.quality}px`;

                item.innerHTML = `
                    <div class="jmg-item-icon" style="${thumbStyle} display:flex;align-items:center;justify-content:center;overflow:hidden;">${thumbContent}</div>
                    <div class="jmg-item-info">
                        <div class="jmg-item-id">${r.id.substring(0, 30)}</div>
                        <div class="jmg-item-quality">${qualityLabel}</div>
                    </div>
                    <button class="jmg-item-download" title="下载">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                    </button>
                `;

                item.querySelector('.jmg-item-download').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    try {
                        const ext = U.getExt(r.url);
                        await U.download(r.url, `即梦_${r.id}.${ext}`);
                        this.toast(`下载成功！`, 'ok');
                    } catch(e) {
                        log.e('下载失败:', e);
                        this.toast('下载失败，请重试', 'err');
                    }
                });

                return item;
            };

            // 渲染分组标题
            const renderSectionHeader = (label, count, color) => {
                const header = document.createElement('div');
                header.style.cssText = `
                    display:flex;align-items:center;gap:6px;
                    padding:8px 16px 4px;
                    font-size:11px;font-weight:600;
                    color:${color};letter-spacing:0.5px;
                    font-family:-apple-system,sans-serif;
                `;
                header.textContent = `${label}  ${count}`;
                return header;
            };

            // 视频分区（在前）
            if (videos.length > 0) {
                body.appendChild(renderSectionHeader('📹 视频', videos.length, '#667eea'));
                videos.forEach(r => body.appendChild(renderItem(r)));
            }

            // 图片分区（在后）
            if (images.length > 0) {
                body.appendChild(renderSectionHeader('🖼 图片', images.length, '#007AFF'));
                images.forEach(r => body.appendChild(renderItem(r)));
            }

            // 空状态
            if (images.length === 0 && videos.length === 0) {
                const empty = document.createElement('div');
                empty.style.cssText = 'text-align:center;padding:32px 16px;color:#8e8e93;font-size:13px;font-family:-apple-system,sans-serif;';
                empty.textContent = '暂未发现资源，请浏览页面后重试';
                body.appendChild(empty);
            }

            // 更新下载全部按钮
            const allBtn = document.getElementById('jmg-download-all');
            const total = images.length + videos.length;
            if (allBtn) {
                allBtn.disabled = total === 0;
                if (total === 0) {
                    allBtn.textContent = '暂无可下载资源';
                } else {
                    const parts = [];
                    if (images.length > 0) parts.push(`${images.length} 图`);
                    if (videos.length > 0) parts.push(`${videos.length} 视频`);
                    allBtn.textContent = `下载全部 (${parts.join(' · ')})`;
                }
            }
        },

        togglePanel() {
            if (!this.panel) return;
            const isOpen = this.panel.classList.contains('open');
            if (isOpen) {
                this.closePanel();
            } else {
                this.panel.classList.add('open');
                this.updatePanel();
            }
        },

        closePanel() {
            if (this.panel) this.panel.classList.remove('open');
        },

        async downloadAll() {
            const seen = new Set();
            const items = S.resources
                .filter(r => {
                    if (seen.has(r.dedupe)) return false;
                    seen.add(r.dedupe);
                    return true;
                })
                .map(r => ({
                    url: r.url,
                    id: r.id,
                    filename: `即梦_${r.id}.${U.getExt(r.url)}`
                }));

            if (items.length === 0) {
                this.toast('暂无可下载资源', 'err');
                return;
            }

            const allBtn = document.getElementById('jmg-download-all');
            if (allBtn) { allBtn.disabled = true; allBtn.textContent = '下载中...'; }

            this.toast(`开始下载 ${items.length} 个文件...`);

            await U.downloadAll(items);

            if (allBtn) { allBtn.disabled = false; allBtn.textContent = `下载全部 (${items.length})`; }
            this.toast(`下载完成！共 ${items.length} 个文件`, 'ok');
        },

        clearResources() {
            S.resources = [];
            this.updateButton();
            this.toast('已清空资源列表');
        },

        toast(msg, type = '') {
            let t = document.getElementById('jmg-toast');
            if (!t) {
                t = document.createElement('div');
                t.id = 'jmg-toast';
                document.body.appendChild(t);
            }
            t.textContent = msg;
            t.className = 'show ' + type;
            clearTimeout(this.toastTimer);
            this.toastTimer = setTimeout(() => t.className = '', 3000);
        }
    };

    // ========================================
    // 初始化
    // ========================================
    function init() {
        log.i('=== 即梦下载器 v4.0 启动 ===');
        log.i('拦截计数:', S.interceptedCount, '| 资源数:', S.resources.length);

        apiInterceptor.init();
        ui.init();
        scanner.init();

        S.ready = true;
    }

    // document-start 时机：尽早注入拦截器
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
