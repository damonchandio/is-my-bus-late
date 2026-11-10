// Small presentational helpers: the bus drawing, operator colours and the toast.

// Illustrative colours per operator so buses are easy to tell apart. These are not official liveries.
const OPERATOR_COLOURS = [
  [/^First/, "#6d2c91"], [/^Arriva/, "#1aa8c4"], [/Keighley/, "#d4202c"], [/Team Pennine/, "#f08a00"],
  [/Harrogate/, "#b5121b"], [/Burnley/, "#e2582b"], [/Coastliner/, "#1f5fa8"], [/^Flyer/, "#0f8a8a"],
  [/^Stagecoach/, "#1d57a5"], [/National Express/, "#5a6772"], [/FlixBus/, "#5cab00"], [/TLC/, "#2b8a3e"],
  [/Connexions/, "#b0188f"], [/East Yorkshire/, "#8a1538"], [/Globe/, "#3f6fb5"], [/Stotts/, "#c0392b"],
]
export const opColour = (operator = "") => OPERATOR_COLOURS.find(([re]) => re.test(operator))?.[1] || "#6a4ad6"

// A double-decker, side on, in one colour. Decorative, so hidden from screen readers.
export const busSvg = (colour, width = 64) => `<svg class="busart" viewBox="0 0 64 40" width="${width}" height="${width * 0.625}" aria-hidden="true">
  <rect x="2" y="3" width="60" height="31" rx="5" fill="${colour}"/>
  <rect x="2" y="16.5" width="60" height="2.5" fill="rgba(255,255,255,.35)"/>
  <rect x="6" y="7" width="47" height="7.5" rx="1.5" fill="#1b2430"/>
  <rect x="14" y="20.5" width="39" height="7.5" rx="1.5" fill="#1b2430"/>
  <path d="M18 7v7.5M30 7v7.5M42 7v7.5M26 20.5V28M38 20.5V28" stroke="${colour}" stroke-width="1.4"/>
  <rect x="6" y="20.5" width="6" height="13.5" rx="1" fill="#1b2430"/>
  <rect x="55" y="7" width="5" height="4" rx="1" fill="#ffb21a"/>
  <rect x="2" y="31" width="60" height="3" fill="rgba(0,0,0,.28)"/>
  <circle cx="17" cy="34.5" r="4.6" fill="#141a22"/><circle cx="17" cy="34.5" r="1.8" fill="#aab2bf"/>
  <circle cx="48" cy="34.5" r="4.6" fill="#141a22"/><circle cx="48" cy="34.5" r="1.8" fill="#aab2bf"/>
</svg>`

let toastTimer
export function toast(text) {
  const el = document.getElementById("toast")
  el.textContent = text
  el.classList.add("show")
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600)
}
