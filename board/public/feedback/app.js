const $ = (id) => document.getElementById(id);
const copy = {
  submit: "Send feedback ↗",
  remove: "Remove screenshot",
  sending: "Sending…",
  too_many_images: "You can attach up to 6 screenshots.",
  invalid_image: "Use PNG, JPG or WebP images, no more than 4 MB each.",
  too_large: "The images are too large. Resize them and try again.",
  invalid_fields: "Add at least one thing: a description, screenshot, title, diagnostics or contact.",
  captcha: "Complete the verification, then submit again.",
  rate_limit: "Too many submissions. Please try again in 10 minutes.",
  unavailable: "We could not send this yet. Try again shortly; your content is still here.",
  invalid_origin: "Please submit again from the feedback page.",
};
let files = [],
  widget,
  config,
  busy = false,
  captchaToken = "",
  requestId = crypto.randomUUID(),
  errorCode;
const form = $("feedback");
// Retry unchanged submissions with the same key; edits start a new submission.
form.addEventListener("input", () => {
  if (!busy) requestId = crypto.randomUUID();
  updateReady();
});
function message(code) {
  errorCode = code;
  $("message").hidden = !code;
  $("message").textContent = code
    ? copy[code] || copy.unavailable
    : "";
}
// Redraws what depends on the state: the button text, the previews, the message.
function render() {
  $("submit").textContent = busy ? copy.sending : copy.submit;
  renderPreviews();
  message(errorCode);
}
function renderPreviews() {
  $("previews").replaceChildren();
  files.forEach((entry, index) => {
    const figure = document.createElement("figure");
    figure.className = "preview";
    const image = document.createElement("img");
    image.src = entry.url;
    image.alt = entry.file.name;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "×";
    button.ariaLabel = `${copy.remove} ${index + 1}`;
    button.disabled = busy;
    button.onclick = () => {
      URL.revokeObjectURL(entry.url);
      files.splice(index, 1);
      requestId = crypto.randomUUID();
      renderPreviews();
      updateReady();
    };
    const caption = document.createElement("figcaption");
    caption.textContent = entry.file.name;
    figure.append(image, button, caption);
    $("previews").append(figure);
  });
}
function addFiles(incoming) {
  if (busy) return;
  const items = Array.from(incoming);
  if (files.length + items.length > 6) return message("too_many_images");
  if (
    items.some(
      (f) =>
        !["image/png", "image/jpeg", "image/webp"].includes(f.type) ||
        !f.size ||
        f.size > 4 * 1024 * 1024,
    )
  )
    return message("invalid_image");
  files.push(
    ...items.map((file) => ({ file, url: URL.createObjectURL(file) })),
  );
  requestId = crypto.randomUUID();
  message();
  renderPreviews();
  updateReady();
}
$("images").onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = "";
};
// Listen on the whole form so images can be pasted while typing. Plain text pastes are left untouched.
form.addEventListener("paste", (e) => {
  const images = Array.from(e.clipboardData?.items || [])
    .filter((i) => i.kind === "file" && i.type.startsWith("image/"))
    .map((i) => i.getAsFile())
    .filter(Boolean);
  if (images.length) {
    e.preventDefault();
    addFiles(images);
  }
});
const zone = $("dropzone");
for (const event of ["dragenter", "dragover"])
  zone.addEventListener(event, (e) => {
    e.preventDefault();
    zone.classList.add("dragging");
  });
zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
zone.addEventListener("drop", (e) => {
  e.preventDefault();
  zone.classList.remove("dragging");
  addFiles(e.dataTransfer.files);
});
zone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    $("images").click();
  }
});
// Everything is optional, but not nothing at all.
function hasContent() {
  return (
    files.length > 0 ||
    ["title", "description", "report", "contact"].some((name) =>
      form.elements[name].value.trim(),
    )
  );
}
function updateReady() {
  $("submit").disabled =
    busy || !config || (!config.development && !captchaToken) || !hasContent();
}
function resetCaptcha() {
  captchaToken = "";
  if (widget !== undefined && window.turnstile) window.turnstile.reset(widget);
  updateReady();
}
form.onsubmit = async (e) => {
  e.preventDefault();
  if (busy || !form.reportValidity()) return;
  if (!hasContent()) return message("invalid_fields");
  if (!config?.development && !captchaToken) return message("captcha");
  const data = new FormData(form);
  data.delete("images");
  data.set("requestId", requestId);
  data.set("cf-turnstile-response", captchaToken);
  files.forEach((entry) => data.append("images", entry.file));
  busy = true;
  message();
  Array.from(form.elements).forEach((el) => (el.disabled = true));
  render();
  updateReady();
  try {
    const response = await fetch("/api/feedback", {
      method: "POST",
      body: data,
      signal: AbortSignal.timeout(60000),
    });
    const result = await response.json();
    if (!response.ok || !result.id)
      throw new Error(result.error || "unavailable");
    $("receipt").textContent = result.id;
    form.hidden = true;
    $("success").hidden = false;
    files.forEach((f) => URL.revokeObjectURL(f.url));
    files = [];
    form.reset();
    requestId = crypto.randomUUID();
    $("success").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    message(error.message in copy ? error.message : "unavailable");
    $("message").focus();
  } finally {
    busy = false;
    Array.from(form.elements).forEach((el) => (el.disabled = false));
    resetCaptcha();
    render();
  }
};
$("another").onclick = () => {
  form.hidden = false;
  $("success").hidden = true;
  message();
  $("description").focus();
};
// Ctrl/Cmd + Enter sends, so a quick note needs no mouse.
form.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !$("submit").disabled) {
    e.preventDefault();
    form.requestSubmit();
  }
});
// The name the pages show (the Worker's PROJECT_NAME var); "Board" when it is missing.
async function showName() {
  try {
    const response = await fetch("/api/info");
    if (!response.ok) return;
    const name = (await response.json()).projectName;
    if (!name) return;
    $("brand-name").textContent = name;
    $("footer-name").textContent = name;
    $("mark").textContent = Array.from(name)[0].toUpperCase();
    document.title = `${name} · Feedback`;
  } catch {}
}
async function initialize() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error("unavailable");
    config = await response.json();
    if (config.development) return updateReady();
    if (!config.siteKey) throw new Error("unavailable");
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onerror = () => message("unavailable");
    script.onload = () => {
      widget = window.turnstile.render("#captcha", {
        sitekey: config.siteKey,
        action: "feedback",
        language: "auto",
        theme: "light",
        callback: (token) => {
          captchaToken = token;
          if (errorCode === "captcha") message();
          updateReady();
        },
        "expired-callback": () => {
          captchaToken = "";
          updateReady();
        },
        "error-callback": () => {
          captchaToken = "";
          message("captcha");
          updateReady();
        },
      });
    };
    document.head.append(script);
  } catch {
    config = undefined;
    message("unavailable");
  }
}
render();
showName();
initialize();
