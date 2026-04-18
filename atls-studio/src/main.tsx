import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
// Side-effect import: registers the input-compression encoder with toon.ts
// (mirrors `registerDriftCorrectionProvider` pattern in tokenCounter.ts).
import "./utils/toolResultCompression";

// Bootstrap the React application into the DOM root element
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error('Root element #root not found');
}
const appRoot = ReactDOM.createRoot(rootElement);

// Strict mode enables extra development checks
// See: https://react.dev/reference/react/StrictMode
appRoot.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
