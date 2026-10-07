import type { Context } from "hono";
import type { User } from "@thirty/shared";

/** Hono environment shared by every router. `user`/`uid` are set by requireUser / optionalUser. */
export type AppEnv = {
  Variables: {
    user: User;
    uid: string;
  };
};

export type AppContext = Context<AppEnv>;

/** The signed-in user on routes that use optionalUser (undefined for anonymous visitors). */
export function viewer(c: AppContext): User | undefined {
  return c.get("user") as User | undefined;
}
