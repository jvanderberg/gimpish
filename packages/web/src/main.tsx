import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ElectronApp } from "./electron/ElectronApp";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root element");

createRoot(container).render(<StrictMode>{window.gimpish ? <ElectronApp /> : <App />}</StrictMode>);
