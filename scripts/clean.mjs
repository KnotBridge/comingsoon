// Remove any stale publish/ so a drag-deploy folder is built from scratch.
import { rmSync } from "fs";
rmSync("publish", { recursive: true, force: true });
console.log("clean: removed publish/");
