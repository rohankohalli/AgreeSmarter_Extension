const screenIdle = document.getElementById("screen-idle")
const screenResults = document.getElementById("screen-results")

const browser_api = typeof chrome !== 'undefined' ? chrome : browser;

document.addEventListener("DOMContentLoaded", async () => {
    // Key exists, check if there's a result for current tab
    const tab = await getCurrentTab()
    const domain = new URL(tab.url).hostname

    browser_api.storage.local.get(`analysis_${domain}`, (result) => {
        const data = result[`analysis_${domain}`]
        if (data && !data.error) {
            showResults(data)
        } else {
            showScreen("idle")
        }
    })
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

    if (name === "idle") screenIdle.classList.remove("hidden")
    if (name === "results") screenResults.classList.remove("hidden")
}

function getCurrentTab() {
    return new Promise(resolve => {
        browser_api.tabs.query({ active: true, currentWindow: true }, tabs => {
            resolve(tabs[0])
        })
    })
}