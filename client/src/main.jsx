import "./index.css";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register Progressive Web App (PWA) Service Worker
if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        console.log("⚡ [PWA] Service Worker registered successfully with scope:", reg.scope);
      })
      .catch((err) => {
        console.warn("⚠️ [PWA] Service Worker registration failed:", err);
      });
  });
}
