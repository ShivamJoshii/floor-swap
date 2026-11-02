import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import BuilderView from "./pages/BuilderView";
import "./styles.css";

// Public builder sheet links: /b/<token> (no login).
const sheet = window.location.pathname.match(/^\/b\/([a-f0-9]{32})\/?$/);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {sheet ? <BuilderView token={sheet[1]} /> : <App />}
  </React.StrictMode>
);
