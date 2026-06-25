import express from "express";
import routes from "./routes";
import swaggerUi from "swagger-ui-express";
import YAML from "yamljs";
import path from "path";
import { errorHandler } from "./middleware/errorHandler";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Live, browsable API docs at /docs ("Try it out" enabled).
  // Loaded from the same openapi.yaml that ships with the repo.
  try {
    const spec = YAML.load(path.join(process.cwd(), "openapi.yaml"));
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));
  } catch {
    // If the spec file isn't found (e.g. unusual cwd), skip docs rather than crash.
    console.warn("openapi.yaml not found — /docs disabled");
  }

  app.use("/api", routes);
  app.use(errorHandler);
  return app;
}
