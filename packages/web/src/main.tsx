import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ElectronApp } from "./electron/ElectronApp";
import { HeadlessRenderApp } from "./headless/HeadlessRenderApp";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

const content = window.gimpishHeadless ? (
  <HeadlessRenderApp />
) : window.gimpish ? (
  <ElectronApp />
) : (
  <App />
);

createRoot(container).render(<StrictMode>{content}</StrictMode>);
