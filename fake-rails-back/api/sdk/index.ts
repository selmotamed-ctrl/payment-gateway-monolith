import { Router } from "express";
import { createHash } from "node:crypto";
import { env } from "../../lib/env";
import { moamalatLightboxScript } from "./moamalat-lightbox.js";
import { mpgsSessionScript } from "./mpgs-session.js";

export const sdkScripts: Record<string, () => string> = {
  "moamalat-lightbox.js": () => moamalatLightboxScript(env.FAKE_RAILS_PUBLIC_BASE_URL),
  "mpgs-session.js": () => mpgsSessionScript(env.FAKE_RAILS_PUBLIC_BASE_URL),
};

/** SRI hash (sha384) of a served script, exposed for the seeder. */
export const sriHash = (name: string): string => {
  const factory = sdkScripts[name];
  if (!factory) return "";
  return `sha384-${createHash("sha384").update(factory()).digest("base64")}`;
};

export const createSdkRouter = (): Router => {
  const router = Router();
  router.get("/:script", (request, response, next) => {
    const factory = sdkScripts[request.params.script ?? ""];
    if (!factory) {
      next();
      return;
    }
    response.type("application/javascript").send(factory());
  });
  router.get("/", (_request, response) => {
    response.json({ scripts: Object.keys(sdkScripts).map((name) => ({ name, sri: sriHash(name) })) });
  });
  return router;
};
