// Render smoke test: mounts ResidentPage and OwnerPage in jsdom with the
// SpacetimeDB WebSocket stubbed out, to prove the pages render without throwing
// (i.e. no blank page / runtime crash) even before any data arrives.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body><div id=root></div></body></html>", {
  url: "http://localhost:5173/owner",
  pretendToBeVisual: true,
});
const g = globalThis as any;
g.window = dom.window;
g.document = dom.window.document;
g.localStorage = dom.window.localStorage;
g.HTMLElement = dom.window.HTMLElement;
g.location = dom.window.location;
// Stub WebSocket so the SDK "connects" but never does anything.
g.WebSocket = class {
  onopen: any; onclose: any; onmessage: any; onerror: any;
  readyState = 0;
  constructor() {}
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
};

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const ResidentPage = (await import("./src/pages/ResidentPage.tsx")).default;
const OwnerPage = (await import("./src/pages/OwnerPage.tsx")).default;

function tryRender(name: string, Page: any, path: string) {
  const el = dom.window.document.createElement("div");
  const root = createRoot(el);
  let ok = true;
  try {
    root.render(
      React.createElement(MemoryRouter, { initialEntries: [path] },
        React.createElement(Page)),
    );
  } catch (e) {
    ok = false;
    console.error(`[render] ${name} THREW:`, e);
  }
  // give effects a tick
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const html = el.innerHTML;
      const rendered = html.length > 200 && /VoltPass/.test(html);
      console.log(`[render] ${name}: ${ok && rendered ? "OK" : "FAIL"} (${html.length} bytes)`);
      if (!rendered) console.error(html.slice(0, 400));
      resolve();
    }, 200);
  });
}

await tryRender("ResidentPage", ResidentPage, "/resident");
await tryRender("OwnerPage", OwnerPage, "/owner");
console.log("[render] done");
process.exit(0);
