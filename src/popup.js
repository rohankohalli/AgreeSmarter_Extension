const screenIdle = document.getElementById("screen-idle")
const screenResults = document.getElementById("screen-results")
const screenSettings = document.getElementById("screen-settings")

const browser_api = typeof chrome !== 'undefined' ? chrome : browser;
let previousScreen = "idle"

document.addEventListener("DOMContentLoaded", async () => {
    setupSettingsHandlers()

    try {
        const storage = await browser_api.storage.local.get("groqApiKey")
        if (!storage.groqApiKey) {
            showScreen("settings")
            return
        }

        const tab = await getCurrentTab()
        if (!tab || !tab.url) {
            showScreen("idle")
            return
        }

        const domain = new URL(tab.url).hostname
        const result = await browser_api.storage.local.get(`analysis_${domain}`)
        const data = result[`analysis_${domain}`]
        if (data && !data.error) {
            showResults(data)
        } else {
            showScreen("idle")
        }
    } catch (err) {
        console.error("[AgreeSmarter] Error loading popup data:", err)
        showScreen("idle")
    }
})

// ── Show results ──────────────────────────────────────────
function showResults(data) {
    showScreen("results")

    // Domain
    document.getElementById("result-domain").textContent = data.domain || ""

    // Score badge
    const scoreBadge = document.getElementById("result-score")
    const score = data.score || 0
    const stars = "★".repeat(score) + "☆".repeat(5 - score)
    scoreBadge.textContent = stars
    scoreBadge.className = "score-badge"
    if (score <= 2) scoreBadge.classList.add("bad")
    else if (score === 3) scoreBadge.classList.add("mid")
    else scoreBadge.classList.add("good")

    // Summary
    document.getElementById("result-summary").textContent =
        data.summary || ""

    // Red flags
    renderList("list-red", "result-red", data.red)
    renderList("list-yellow", "result-yellow", data.yellow)
    renderList("list-green", "result-green", data.green)
}

function renderList(listId, sectionId, items) {
    const section = document.getElementById(sectionId)
    const list = document.getElementById(listId)

    if (!items || items.length === 0) {
        section.classList.add("hidden")
        return
    }

    section.classList.remove("hidden")
    list.innerHTML = ""
    items.forEach(item => {
        const li = document.createElement("li")
        li.textContent = item
        list.appendChild(li)
    })
}

//Helpers
function showScreen(name) {
    screenIdle.classList.add("hidden")
    screenResults.classList.add("hidden")
    screenSettings.classList.add("hidden")

    if (name === "idle") screenIdle.classList.remove("hidden")
    if (name === "results") screenResults.classList.remove("hidden")
    if (name === "settings") screenSettings.classList.remove("hidden")
}

async function getCurrentTab() {
    const tabs = await browser_api.tabs.query({ active: true, currentWindow: true })
    return tabs[0]
}

function setupSettingsHandlers() {
    const btnSettings = document.getElementById("btn-settings")
    const btnBackSettings = document.getElementById("btn-back-settings")
    const btnSaveKey = document.getElementById("save-key-btn")
    const apiKeyInput = document.getElementById("api-key-input")
    const saveStatus = document.getElementById("save-status")
    const rotationWarning = document.getElementById("rotation-warning")

    // Open settings screen
    btnSettings.addEventListener("click", async () => {
        if (!screenIdle.classList.contains("hidden")) previousScreen = "idle"
        else if (!screenResults.classList.contains("hidden")) previousScreen = "results"
        else previousScreen = "idle"

        showScreen("settings")

        // Load existing key & show rotation warning if key is old (90 days)
        const data = await browser_api.storage.local.get(["groqApiKey", "apiKeySavedAt"])
        if (data.groqApiKey) {
            apiKeyInput.value = data.groqApiKey

            if (data.apiKeySavedAt) {
                const rotationPeriod = 90 * 24 * 60 * 60 * 1000 // 90 days in ms
                if (Date.now() - data.apiKeySavedAt > rotationPeriod) {
                    rotationWarning.classList.remove("hidden")
                } else {
                    rotationWarning.classList.add("hidden")
                }
            }
        }
    })

    // Back button
    btnBackSettings.addEventListener("click", () => {
        showScreen(previousScreen)
        saveStatus.classList.add("hidden")
    })

    // Save key button
    btnSaveKey.addEventListener("click", async () => {
        const key = apiKeyInput.value.trim()
        if (!key) {
            alert("Please enter a valid API key.")
            return
        }

        await browser_api.storage.local.set({
            groqApiKey: key,
            apiKeySavedAt: Date.now()
        })

        // Clear input field on success for privacy
        apiKeyInput.value = ""

        saveStatus.classList.remove("hidden")
        setTimeout(() => {
            saveStatus.classList.add("hidden")
        }, 3000)

        rotationWarning.classList.add("hidden")
    })
}