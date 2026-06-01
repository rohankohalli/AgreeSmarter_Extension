const CONSENT_KEYWORDS = /privacy|terms|conditions|gdpr|data\s*policy|consent|personal\s*data|data\s*processing|cookies/i

const POLICY_LINK_KEYWORDS = /privacy|terms|conditions|legal|policy/i

const browser_api = typeof chrome !== 'undefined' ? chrome : browser;

// Track analyzed checkboxes to avoid duplicates
const analyzed = new WeakSet()

// ── Main entry point ──────────────────────────────────────
function init() {
    scanForCheckboxes()
    scanForPassiveConsent()

    // Watch for dynamically loaded forms (SPAs, modals)
    const observer = new MutationObserver(() => {
        scanForCheckboxes()
        scanForPassiveConsent()
    })

    observer.observe(document.body, {
        childList: true,
        subtree: true
    })
}

// ── Find all consent checkboxes on page ───────────────────
function scanForCheckboxes() {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]')

    checkboxes.forEach(checkbox => {
        if (analyzed.has(checkbox)) return // skip already processed

        const consentText = getConsentContext(checkbox)
        if (!consentText) return // not a consent checkbox

        analyzed.add(checkbox)
        injectBadge(checkbox, consentText, true)
    })
}

const PASSIVE_KEYWORDS = /by\s+(?:signing\s*up|registering|clicking|continuing|creating|signing\s*in|submitting|logging\s*in)\b[\s\S]*?(?:agree|accept|consent|terms|policy|t&c)/i

// ── Find all passive/implicit consent notices on page ───
function scanForPassiveConsent() {
    const elements = document.querySelectorAll('p, span, div, label, small')

    elements.forEach(el => {
        if (analyzed.has(el)) return

        const text = el.innerText || ""
        if (text.length > 300 || !PASSIVE_KEYWORDS.test(text)) return

        // Ensure it contains a policy link
        const link = el.querySelector('a[href]')
        if (!link) return

        // Skip if it contains a checkbox (that is handled by checkbox scan)
        if (el.querySelector('input[type="checkbox"]')) return

        analyzed.add(el)
        injectBadge(el, text, false)
    })
}

// ── Get text/link associated with checkbox ────────────────
function getConsentContext(checkbox) {
    // 1. Check associated <label>
    let text = ""

    const labelEl = checkbox.labels?.[0] ||
        document.querySelector(`label[for="${checkbox.id}"]`)
    if (labelEl) text += labelEl.innerText + " "

    // 2. Check parent container text (up to 3 levels)
    let parent = checkbox.parentElement
    for (let i = 0; i < 3; i++) {
        if (!parent) break
        text += parent.innerText + " "
        parent = parent.parentElement
    }

    // 3. Does it contain consent language?
    if (!CONSENT_KEYWORDS.test(text)) return null

    return text.slice(0, 5000).trim()
}

// ── Find policy link near checkbox ───────────────────────
function findPolicyLink(checkbox) {
    let parent = checkbox.parentElement
    for (let i = 0; i < 4; i++) {
        if (!parent) break
        const links = parent.querySelectorAll("a[href]")
        for (const link of links) {
            if (POLICY_LINK_KEYWORDS.test(link.href) ||
                POLICY_LINK_KEYWORDS.test(link.innerText)) {
                return link.href
            }
        }
        parent = parent.parentElement
    }
    return null
}

// ── Inject inline badge near checkbox or text ───
function injectBadge(element, consentText, isCheckbox = true) {
    // Create badge container
    const badge = document.createElement("div")
    badge.className = "agreeSmarter-badge"

    const loadingSpan = document.createElement("span")
    loadingSpan.className = "as-loading"
    loadingSpan.textContent = "🔍 AgreeSmarter analyzing..."
    badge.appendChild(loadingSpan)

    // Inject right after checkbox, or append to passive text container
    if (isCheckbox) {
        element.insertAdjacentElement("afterend", badge)
    } else {
        element.appendChild(badge)
    }

    // Send text to background for analysis
    const domain = window.location.hostname
    const policyLink = isCheckbox
        ? findPolicyLink(element)
        : element.querySelector('a[href]')?.href

    // Use inline text first, fall back to fetching link
    const textToAnalyze = consentText.length > 200
        ? consentText
        : policyLink
            ? `Policy found at: ${policyLink} \n\n${consentText}`
            : consentText

    browser_api.runtime.sendMessage(
        {
            type: "ANALYZE_PRIVACY_POLICY",
            text: textToAnalyze,
            domain: domain
        },
        (response) => {
            if (!response || !response.success) {
                const errMsg = response?.error || "unknown"
                badge.innerHTML = ""

                if (errMsg === "NO_API_KEY") {
                    const nkeySpan = document.createElement("span")
                    nkeySpan.className = "as-nokey"
                    nkeySpan.textContent = "🔑 Add Groq API key in AgreeSmarter "
                    const btn = document.createElement("button")
                    btn.className = "as-open-popup"
                    btn.textContent = "Set Key →"
                    btn.addEventListener("click", () => {
                        browser_api.runtime.sendMessage({ type: "OPEN_POPUP" })
                    })
                    nkeySpan.appendChild(btn)
                    badge.appendChild(nkeySpan)
                } else {
                    const errSpan = document.createElement("span")
                    errSpan.className = "as-error"
                    errSpan.textContent = "⚠️ AgreeSmarter: analysis failed"
                    badge.appendChild(errSpan)
                }
                return
            }

            const data = response.data

            if (data.error) {
                badge.innerHTML = ""
                const warnSpan = document.createElement("span")
                warnSpan.className = "as-warn"
                warnSpan.textContent = "ℹ️ Not enough policy text found"
                badge.appendChild(warnSpan)
                return
            }

            // Build inline summary
            const redCount = data.red?.length || 0
            const yellowCount = data.yellow?.length || 0
            const greenCount = data.green?.length || 0
            const score = data.score || "?"
            const summary = data.summary || ""

            const scoreColor = score <= 2
                ? "#e74c3c"
                : score === 3
                    ? "#f39c12"
                    : "#27ae60"

            badge.innerHTML = ""
            const summarySpan = document.createElement("span")
            summarySpan.className = "as-summary"
            summarySpan.innerHTML = `${"🔴".repeat(redCount)}${"🟡".repeat(yellowCount)}${"🟢".repeat(greenCount)}&nbsp;<span class="as-score" style="color:${scoreColor}">${score}/5</span>&nbsp;·&nbsp;<span class="as-text">${summary}</span>&nbsp;`

            const detailsBtn = document.createElement("button")
            detailsBtn.className = "as-details-btn"
            detailsBtn.textContent = "Details →"
            detailsBtn.addEventListener("click", () => {
                browser_api.runtime.sendMessage({ type: "OPEN_POPUP" })
            })
            summarySpan.appendChild(detailsBtn)
            badge.appendChild(summarySpan)

            // Store result for popup to read
            browser_api.storage.local.set({
                [`analysis_${domain}`]: {
                    ...data,
                    domain,
                    timestamp: Date.now()
                }
            })
        }
    )
}

// ── Start ─────────────────────────────────────────────────
init()