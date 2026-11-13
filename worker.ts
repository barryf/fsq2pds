import { run, type Env } from "./lib/run.ts";

export default {
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(run(env));
  },
} satisfies ExportedHandler<Env>;
