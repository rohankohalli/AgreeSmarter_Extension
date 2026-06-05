try {
    importScripts('/src/config.js');
} catch (e) {
    console.error("Failed to import config.js:", e);
}

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
const MODEL = "llama-3.1-8b-instant"

const browser_api = typeof chrome !== 'undefined' ? chrome : browser;

// Listen for messages from content_script or popup
browser_api.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "ANALYZE_PRIVACY_POLICY") {
        (async () => {
            try {
                const result = await analyzePrivacyPolicy(request.text, request.domain);
                sendResponse({ success: true, data: result });
            } catch (err) {
                console.error("Error in ANALYZE_PRIVACY_POLICY:", err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true; // keeps message channel open for async
    }

    else if (request.type === "OPEN_POPUP") {
        (async () => {
            try {
                await browser_api.action.openPopup();
                sendResponse({ success: true });
            } catch (err) {
                console.error("Error in OPEN_POPUP:", err);
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }
})

// Helper: Clean HTML tags and scripts from fetched policies
function cleanHtml(html) {
    if (!html) return '';
    return html
        .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
        .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Helper: Parse Groq's reset time string (e.g. "6s", "1m4.2s", "120ms") to milliseconds
function parseResetTime(resetStr) {
    if (!resetStr) return 1000;
    let ms = 0;
    
    if (resetStr.endsWith("ms")) {
        const val = parseFloat(resetStr);
        return isNaN(val) ? 1000 : val;
    }
    
    const minMatch = resetStr.match(/(\d+)m/);
    if (minMatch) {
        ms += parseInt(minMatch[1], 10) * 60 * 1000;
    }
    
    const secMatch = resetStr.replace(/\d+ms/, "").match(/(\d+(?:\.\d+)?)s/);
    if (secMatch) {
        ms += parseFloat(secMatch[1]) * 1000;
    }
    
    return ms || 1000;
}

// Helper: Check cached rate limits and throw errors if at/above 85% consumption
async function checkRateLimits() {
    const data = await browser_api.storage.local.get([
        "rateLimitLimitTokens",
        "rateLimitRemainingTokens",
        "rateLimitResetTokensAt",
        "rateLimitLimitRequests",
        "rateLimitRemainingRequests",
        "rateLimitResetRequestsAt",
        "rateLimitDailyBlockUntil"
    ]);

    const now = Date.now();

    // Check Daily limit (RPD / TPD)
    if (data.rateLimitDailyBlockUntil && now < data.rateLimitDailyBlockUntil) {
        const waitMs = data.rateLimitDailyBlockUntil - now;
        const waitHours = Math.ceil(waitMs / (1000 * 60 * 60));
        throw new Error(`RATE_LIMIT_DAILY:Daily limit reached. Resets in ${waitHours}h.`);
    }

    // Check TPM (Tokens per minute)
    if (data.rateLimitResetTokensAt && now < data.rateLimitResetTokensAt) {
        const limit = data.rateLimitLimitTokens || 0;
        const remaining = data.rateLimitRemainingTokens || 0;
        if (limit > 0) {
            const consumption = 1 - (remaining / limit);
            if (consumption >= 0.85) {
                const waitSec = Math.ceil((data.rateLimitResetTokensAt - now) / 1000);
                throw new Error(`RATE_LIMIT_85_TOKENS:Please wait ${waitSec}s (85%+ tokens consumed).`);
            }
        }
    }

    // Check RPM (Requests per minute)
    if (data.rateLimitResetRequestsAt && now < data.rateLimitResetRequestsAt) {
        const limit = data.rateLimitLimitRequests || 0;
        const remaining = data.rateLimitRemainingRequests || 0;
        if (limit > 0) {
            const consumption = 1 - (remaining / limit);
            if (consumption >= 0.85) {
                const waitSec = Math.ceil((data.rateLimitResetRequestsAt - now) / 1000);
                throw new Error(`RATE_LIMIT_85_REQUESTS:Please wait ${waitSec}s (85%+ requests consumed).`);
            }
        }
    }
}

// Helper: Update rate limit cache using headers from response
async function updateRateLimits(headers) {
    const limitTokens = headers.get("x-ratelimit-limit-tokens");
    const remainingTokens = headers.get("x-ratelimit-remaining-tokens");
    const resetTokens = headers.get("x-ratelimit-reset-tokens");

    const limitRequests = headers.get("x-ratelimit-limit-requests");
    const remainingRequests = headers.get("x-ratelimit-remaining-requests");
    const resetRequests = headers.get("x-ratelimit-reset-requests");

    const updates = {};
    const now = Date.now();

    if (limitTokens && remainingTokens) {
        updates.rateLimitLimitTokens = parseInt(limitTokens, 10);
        updates.rateLimitRemainingTokens = parseInt(remainingTokens, 10);
        updates.rateLimitResetTokensAt = now + parseResetTime(resetTokens);
    }

    if (limitRequests && remainingRequests) {
        updates.rateLimitLimitRequests = parseInt(limitRequests, 10);
        updates.rateLimitRemainingRequests = parseInt(remainingRequests, 10);
        updates.rateLimitResetRequestsAt = now + parseResetTime(resetRequests);
    }

    if (Object.keys(updates).length > 0) {
        await browser_api.storage.local.set(updates);
    }
}

// Helper: Set block for the rest of the day until next UTC midnight
async function setDailyBlock() {
    const now = new Date();
    const nextMidnight = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0, 0, 0, 0
    );
    await browser_api.storage.local.set({
        rateLimitDailyBlockUntil: nextMidnight
    });
}

const CACHE_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function analyzePrivacyPolicy(text, domain) {
    // Check limits before making any API requests
    await checkRateLimits();

    // Load key dynamically from local storage
    const storageData = await browser_api.storage.local.get("groqApiKey");
    let apiKey = storageData.groqApiKey;

    // Fallback to hardcoded key in config.js if no key exists in local storage
    if (!apiKey && typeof CONFIG !== 'undefined') {
        apiKey = CONFIG?.GROQ_API_KEY;
    }

    if (!apiKey) {
        console.error("❌ API Key missing - not configured in storage or config.js")
        throw new Error("NO_API_KEY")
    }

    // Check cached analysis for the domain to save API quota
    const cacheKey = `analysis_${domain}`;
    const cached = await browser_api.storage.local.get(cacheKey);
    const cachedData = cached[cacheKey];

    if (cachedData && !cachedData.error && cachedData.timestamp) {
        const age = Date.now() - cachedData.timestamp;
        if (age < CACHE_EXPIRATION_MS) {
            console.log(`✓ Using cached analysis for ${domain} (age: ${Math.round(age / (1000 * 60 * 60))}h)`);
            return cachedData;
        }
    }

    console.log("✓ API Key loaded, analyzing:", domain)

    let textToAnalyze = text;

    // Detect if text is actually a URL payload and fetch it
    if (text.includes("Policy found at:")) {
        const urlMatch = text.match(/https?:\/\/[^\s]+/);
        if (urlMatch) {
            const url = urlMatch[0];
            try {
                // Fetch the real terms/privacy webpage with a 10s timeout
                const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
                if (res.ok) {
                    const html = await res.text();
                    const cleaned = cleanHtml(html);
                    if (cleaned.length > 100) {
                        textToAnalyze = `Fetched Policy Content from ${url}:\n\n${cleaned}`;
                    }
                }
            } catch (e) {
                console.error("Failed to fetch terms URL. Falling back to inline text.", e);
            }
        }
    }

    // Truncate text to avoid hitting token limits ~3000 tokens max = roughly 12000 characters
    const truncated = textToAnalyze.slice(0, 12000)

    const prompt = `You are a privacy policy analyst protecting everyday users.

Analyze the following privacy policy or terms of service text and return ONLY a valid JSON object. No markdown, no preamble, no explanation just the JSON.

Return this exact structure:
{
  "red": ["issue1", "issue2"],
  "yellow": ["issue1"],
  "green": ["issue1"],
  "summary": "max 10 words plain English",
  "score": 3
}

Rules:
- red: serious privacy violations or user-hostile clauses
- yellow: clauses to be cautious about
- green: user-friendly or privacy-respecting clauses
- summary: one plain English sentence, max 10 words
- score: 1 (terrible) to 5 (excellent) for user privacy
- max 2 sentences per item
- plain English only, no legal jargon
- if text is too short or irrelevant return: {"error": "insufficient text"}
- do NOT hallucinate clauses not present in the text
- empty array [] if nothing found for a category

Domain: ${domain}
Text: ${truncated}`

    let response;
    try {
        response = await fetch(GROQ_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: MODEL,
                max_tokens: 1000,
                temperature: 0.1,
                messages: [
                    { role: "user", content: prompt }
                ]
            })
        });
    } catch (e) {
        console.error("❌ Network / Fetch Error to Groq API:", e);
        throw new Error(`Failed to fetch Groq API: ${e.message}`);
    }

    // Proactively capture rate limits from response headers
    if (response) {
        await updateRateLimits(response.headers);
    }

    if (!response.ok) {
        let errMsg = "Groq API error";
        try {
            const err = await response.json();
            errMsg = err.error?.message || "Groq API error";
        } catch (e) {
            errMsg = `HTTP Error ${response.status}`;
        }
        console.error("❌ API Error:", response.status, errMsg);
        
        // Handle 429 daily limits (RPD / TPD)
        if (response.status === 429) {
            const lowerMsg = errMsg.toLowerCase();
            if (lowerMsg.includes("daily") || lowerMsg.includes("limit reached")) {
                await setDailyBlock();
                throw new Error("RATE_LIMIT_DAILY:Daily limit reached. Resets tomorrow.");
            }
        }
        
        throw new Error(errMsg);
    }

    const data = await response.json()
    const raw = data.choices[0].message.content.trim()

    // Safely parse JSON — strip any accidental markdown
    const cleaned = raw.replace(/```json|```/g, "").trim()

    try {
        const parsed = JSON.parse(cleaned)
        console.log("✓ Analysis complete:", parsed)
        return parsed
    } catch (e) {
        console.error("❌ JSON Parse Error:", cleaned)
        throw new Error("Invalid JSON from model")
    }
}