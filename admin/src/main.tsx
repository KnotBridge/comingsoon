import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import App from "./App";
import "./index.css";

// The ported outreach components use react-router hooks (useNavigate/Link), so
// the tree must sit inside a Router even though the app navigates by tab state.
// basename matches where the SPA is served (/admin).
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename="/admin">
      <AuthProvider>
        <TooltipProvider delayDuration={200}>
          <App />
          <Toaster position="top-right" richColors closeButton />
        </TooltipProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
