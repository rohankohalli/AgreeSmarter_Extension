importScripts('/src/config.js')
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions"
const MODEL = "llama-3.1-8b-instant"

const browser_api = typeof chrome !== 'undefined' ? chrome : browser;

// Listen for messages from content_script or popup
browser_api.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "ANALYZE_PRIVACY_POLICY") {
        analyzePrivacyPolicy(request.text, request.domain)
            .then(result => sendResponse({ success: true, data: result }))
            .catch(err => sendResponse({ success: false, error: err.message }))
        return true // keeps message channel open for async
    }

    else if (request.type === "OPEN_POPUP") {
        browser_api.action.openPopup()
            .then(() => sendResponse({ success: true }))
            .catch(err => sendResponse({ success: false, error: err.message }))
        return true
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

async function analyzePrivacyPolicy(text, domain) {
    const apiKey = CONFIG.GROQ_API_KEY
    if (!apiKey) throw new Error("NO_API_KEY")

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

    const response = await fetch(GROQ_API_URL, {
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
    })

    if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error?.message || "Groq API error")
    }

    const data = await response.json()
    const raw = data.choices[0].message.content.trim()

    // Safely parse JSON — strip any accidental markdown
    const cleaned = raw.replace(/```json|```/g, "").trim()

    try {
        return JSON.parse(cleaned)
    } catch {
        throw new Error("Invalid JSON from model")
    }
}