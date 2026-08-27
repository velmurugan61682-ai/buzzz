/* Standalone preview entry for the internal console.
   It lives inside the app so it resolves the same React instance as App.jsx:
   bundling an entry from outside the project pulls in a second copy of React
   and every hook fails with a null dispatcher. */
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  React.createElement(App, {
    __staff: { staff: { id: "staff-owner", email: "owner@buzzzbuzzz.com", name: "Owner", role: "superadmin" }, demo: true },
  })
);
