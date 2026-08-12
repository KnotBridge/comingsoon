import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider } from "@/contexts/AuthContext";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <TooltipProvider delayDuration={200}>
        <App />
        <Toaster position="top-right" richColors closeButton />
      </TooltipProvider>
    </AuthProvider>
  </React.StrictMode>
);
