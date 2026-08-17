import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Cities from "./Cities.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Cities />
  </StrictMode>
);
