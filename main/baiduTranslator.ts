// BACKGROUND ONLY. Never import this module from content or extension pages.
// Baidu General Translation API: https://fanyi-api.baidu.com/doc/21
import { baiduMd5 } from "@/main/baiduMd5";
import { utf8Length } from "@/utils/text";

const ENDPOINT = "https://fanyi-api.baidu.com/api/trans/vip/translate";
const MAX_QUERY_BYTES = 5800; // below Baidu's recommended 6000 UTF-8 bytes
const MAX_PART_BYTES = 5600;
const MAX_BATCH_ITEMS = 50;
const REQUEST_TIMEOUT_MS = 25_000;

export interface BaiduCredentials {
    appId: string;
    secretKey: string;
    qps?: number;
}

export interface BaiduTranslation {
    text: string;
    /** Baidu detects one source language for a whole request, not per row. */
    sourceLang: string;
}

interface BaiduResponse {
    from?: string;
    trans_result: Array<{ src?: string; dst: string }>;
}

interface Slot {
    query: string;
    translated: string;
    from: string;
    signature?: string;
    original?: string;
    html?: string;
}
type Part = string | Slot;
type Signal = AbortSignal | null | undefined;

const LANGUAGES: Record<string, string> = {
    "zh-CN": "zh", "zh-TW": "cht", zh: "zh", en: "en", ja: "jp", ko: "kor",
    fr: "fra", es: "spa", th: "th", ar: "ara", ru: "ru", pt: "pt", de: "de",
    it: "it", el: "el", nl: "nl", pl: "pl", bg: "bul", et: "est", da: "dan",
    fi: "fin", cs: "cs", ro: "rom", sl: "slo", sv: "swe", hu: "hu", vi: "vie", yue: "yue",
};
const REVERSE_LANGUAGES = Object.fromEntries(Object.entries(LANGUAGES).map(([a, b]) => [b, a]));
REVERSE_LANGUAGES.zh = "zh-CN";

export function toBaiduLanguage(language: string): string | undefined {
    return LANGUAGES[language];
}

export function fromBaiduLanguage(language: string): string {
    return REVERSE_LANGUAGES[language] || language;
}

const ERRORS: Record<string, string> = {
    52001: "请求超时，请稍后重试", 52002: "百度服务暂时异常，请稍后重试",
    52003: "APPID 无效或尚未开通通用翻译服务", 54000: "请求参数缺失",
    54001: "签名错误，请检查 APPID 和密钥", 54003: "请求频率超限，请调低 QPS",
    54004: "账户余额或可用额度不足", 54005: "长文本请求频繁，请稍后重试",
    58000: "当前出口 IP 不符合百度控制台的 IP 限制", 58001: "不支持当前翻译语言",
    58002: "通用翻译服务已关闭，请在百度控制台开启", 58003: "当前 IP 触发百度风控",
    90107: "百度开发者认证未通过或尚未生效",
};

function abortError(signal: Signal): Error {
    return signal?.reason instanceof Error && signal.reason.name === "AbortError"
        ? signal.reason : new DOMException("Translation cancelled", "AbortError");
}
function checkAbort(signal: Signal): void {
    if (signal?.aborted) throw abortError(signal);
}
function delay(ms: number, signal: Signal): Promise<void> {
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const finish = () => { signal?.removeEventListener("abort", cancel); resolve(); };
        const timer = setTimeout(finish, Math.max(0, ms));
        const cancel = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            reject(abortError(signal));
        };
        signal?.addEventListener("abort", cancel, { once: true });
    });
}
function abortable<T>(promise: Promise<T>, signal: Signal): Promise<T> {
    if (!signal) return promise;
    checkAbort(signal);
    return new Promise((resolve, reject) => {
        const cancel = () => reject(abortError(signal));
        signal.addEventListener("abort", cancel, { once: true });
        void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
    });
}

/** Decode the entities emitted by the DOM's mapped HTML serializer. No DOM APIs
 * are available in an MV3 worker. Decode once, then escape provider output once.
 */
function decodeHtml(text: string): string {
    return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity: string) => {
        const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
        if (entity[0] !== "#") return entities[entity.toLowerCase()] ?? all;
        const value = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
            ? String.fromCodePoint(value) : all;
    });
}
function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// Sequential, rather than sorted: preserve nesting as well as every marker.
function tagSignature(text: string): string {
    return (text.match(/<\/?b\d+>/g) || []).join("");
}
function escapeMappedHtml(text: string): string {
    return text.split(/(<\/?b\d+>)/g)
        .map(part => /^<\/?b\d+>$/.test(part) ? part : escapeHtml(part)).join("");
}

/** Split by code point, so CJK and emoji respect the byte budget without
 * cutting a surrogate pair. Markup is separated before this helper is used.
 */
export function splitBaiduUtf8(text: string, maxBytes = MAX_PART_BYTES): string[] {
    const result: string[] = [];
    let part = "", size = 0;
    for (const char of text) {
        const bytes = utf8Length(char);
        if (size + bytes > maxBytes) { result.push(part); part = ""; size = 0; }
        part += char;
        size += bytes;
    }
    if (part) result.push(part);
    return result;
}

// One queue across all tabs, frames, subtitles, and draft-credential tests.
// A rejected/cancelled job never poisons the next request in the queue.
let queue: Promise<unknown> = Promise.resolve();
let nextStart = 0;
function enqueue<T>(job: () => Promise<T>, qps: number, signal: Signal): Promise<T> {
    const pending = queue.then(async () => {
        checkAbort(signal);
        await delay(nextStart - Date.now(), signal);
        checkAbort(signal);
        nextStart = Date.now() + Math.ceil(1000 / qps) + 30;
        return job();
    });
    queue = pending.catch(() => {});
    return abortable(pending, signal);
}

export class BaiduTranslator {
    constructor(private readonly getCredentials: () => Promise<BaiduCredentials>) { }

    async detectLanguage(texts: string[], signal?: AbortSignal | null): Promise<string> {
        const plain = decodeHtml(texts.join("\n").replace(/<\/?b\d+>/g, "")).trim();
        if (!plain) return "";
        // A single bounded sample, never a separately billed request per row.
        const sample = splitBaiduUtf8(plain, 800)[0];
        return (await this.translateText([escapeHtml(sample)], "zh-CN", signal))[0]?.sourceLang || "";
    }

    async translateText(
        texts: string[], targetLang: string, signal?: AbortSignal | null, sourceLang?: string,
    ): Promise<BaiduTranslation[]> {
        if (!texts.length) return [];
        checkAbort(signal);
        const raw = await this.getCredentials();
        const credentials: Required<BaiduCredentials> = {
            appId: String(raw.appId ?? "").trim(), secretKey: String(raw.secretKey ?? "").trim(),
            qps: Math.min(100, Math.max(1, Math.floor(Number(raw.qps) || 1))),
        };
        if (!credentials.appId || !credentials.secretKey) {
            throw new Error("请先在翻译服务设置中填写百度 APPID 和密钥");
        }
        const to = toBaiduLanguage(targetLang);
        if (!to) throw new Error(`百度翻译暂未适配目标语言：${targetLang}`);
        const from = sourceLang ? toBaiduLanguage(sourceLang) : "auto";
        if (!from) throw new Error(`百度翻译暂未适配源语言：${sourceLang}`);

        const slots: Slot[] = [];
        const plainParts = (part: string): Part[] => splitBaiduUtf8(decodeHtml(part)).flatMap(chunk => {
            const [, before, query, after] = chunk.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
            if (!query) return [escapeHtml(chunk)];
            const slot: Slot = { query, translated: "", from: "" };
            slots.push(slot);
            return [escapeHtml(before), slot, escapeHtml(after)];
        });
        const plans: Part[][] = texts.map(text => String(text).split(/(\r\n|\r|\n)/g).flatMap((part): Part[] => {
            if (/^(?:\r\n|\r|\n)$/.test(part) || !part.trim()) return [part];
            const signature = tagSignature(part);
            if (signature && !decodeHtml(part.replace(/<\/?b\d+>/g, "")).trim()) return [part];
            if (signature && utf8Length(decodeHtml(part)) <= MAX_PART_BYTES) {
                const [, before, content, after] = part.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
                const slot: Slot = { query: decodeHtml(content), translated: "", from: "", signature, original: content };
                slots.push(slot);
                return [before, slot, after];
            }
            return part.split(/(<\/?b\d+>)/g).flatMap(piece => /^<\/?b\d+>$/.test(piece) ? [piece] : plainParts(piece));
        }));

        let batch: Slot[] = [], bytes = 0;
        const apply = (slot: Slot, row: BaiduResponse["trans_result"][number], detected?: string) => {
            slot.translated = row.dst;
            slot.from = detected || "";
        };
        const flush = async () => {
            if (!batch.length) return;
            const current = batch;
            batch = []; bytes = 0;
            const response = await this.request(current.map(slot => slot.query).join("\n"), from, to, credentials, signal);
            if (response.trans_result.length !== current.length) {
                // Never position one paragraph's translation in another one.
                if (current.length === 1) throw new Error("百度返回的翻译段落数量不匹配，请缩短段落后重试");
                for (const slot of current) {
                    const single = await this.request(slot.query, from, to, credentials, signal);
                    if (single.trans_result.length !== 1) throw new Error("百度返回的翻译段落数量不匹配");
                    apply(slot, single.trans_result[0], single.from);
                }
            } else {
                current.forEach((slot, index) => apply(slot, response.trans_result[index], response.from));
            }
        };
        for (const slot of slots) {
            const size = utf8Length(slot.query);
            if (batch.length && (bytes + 1 + size > MAX_QUERY_BYTES || batch.length >= MAX_BATCH_ITEMS)) await flush();
            if (batch.length) bytes++;
            batch.push(slot); bytes += size;
        }
        await flush();

        for (const slot of slots) {
            if (!slot.signature) continue;
            if (tagSignature(slot.translated) === slot.signature) {
                slot.html = escapeMappedHtml(slot.translated);
            } else {
                // Plain-text APIs may translate or discard XML-like tags. Keep
                // the element map locally and retry only this line's spans.
                const pieces = slot.original!.split(/(<\/?b\d+>)/g);
                const indices = pieces.map((piece, index) => /^<\/?b\d+>$/.test(piece) || !piece.trim() ? -1 : index)
                    .filter(index => index >= 0);
                const translated = await this.translateText(indices.map(index => pieces[index]), targetLang, signal, sourceLang);
                indices.forEach((index, i) => { pieces[index] = translated[i].text; });
                slot.html = pieces.join("");
            }
        }
        checkAbort(signal);
        return plans.map(parts => {
            const detected = parts.find((part): part is Slot => typeof part !== "string" && !!part.from)?.from || "";
            return {
                text: parts.map(part => typeof part === "string" ? part : part.html ?? escapeHtml(part.translated)).join(""),
                sourceLang: fromBaiduLanguage(detected),
            };
        });
    }

    private request(query: string, from: string, to: string, credentials: Required<BaiduCredentials>, signal: Signal): Promise<BaiduResponse> {
        return enqueue(async () => {
            const salt = Date.now().toString() + crypto.getRandomValues(new Uint32Array(1))[0].toString();
            const body = new URLSearchParams({ q: query, from, to, appid: credentials.appId, salt,
                sign: baiduMd5(credentials.appId + query + salt + credentials.secretKey) });
            const controller = new AbortController();
            const cancel = () => controller.abort(signal?.reason);
            signal?.addEventListener("abort", cancel, { once: true });
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                checkAbort(signal);
                const response = await fetch(ENDPOINT, {
                    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
                    body: body.toString(), signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer",
                });
                if (!response.ok) throw new Error(`百度翻译 HTTP ${response.status}`);
                const data = await response.json();
                if (data?.error_code && !["0", "52000"].includes(String(data.error_code))) {
                    const code = String(data.error_code);
                    if (code === "54005") nextStart = Math.max(nextStart, Date.now() + 3100);
                    throw new Error(`百度翻译 ${code}：${ERRORS[code] || "接口调用失败，请查看百度控制台"}`);
                }
                if (!Array.isArray(data?.trans_result) || !data.trans_result.length
                    || data.trans_result.some((row: { dst?: unknown } | null) => typeof row?.dst !== "string")) {
                    throw new Error("百度返回了无法识别的翻译结果");
                }
                return data as BaiduResponse;
            } catch (error) {
                if (signal?.aborted) throw abortError(signal);
                if (controller.signal.aborted) throw new Error("百度翻译请求超过 25 秒，请稍后重试");
                if (error instanceof TypeError) throw new Error("无法连接百度翻译，请检查网络连接");
                throw error;
            } finally {
                clearTimeout(timeout);
                signal?.removeEventListener("abort", cancel);
            }
        }, credentials.qps, signal);
    }
}
