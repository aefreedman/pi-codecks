export type CodecksProfile = "ORG" | "PERSONAL";
export type ProfileScope = "task" | "session";

/** This object belongs to one extension instance, not the process or the session transcript. */
export class CodecksProfileSession {
  private selected: CodecksProfile = "ORG";
  private taskPrevious: CodecksProfile | undefined;

  constructor(private readonly startupProfile: () => string | undefined = () => process.env.CODECKS_PROFILE) {}

  start(): void {
    const configured = this.startupProfile()?.trim().toUpperCase();
    if (configured && configured !== "ORG" && configured !== "PERSONAL") throw new Error("CODECKS_PROFILE must be ORG or PERSONAL.");
    this.selected = (configured || "ORG") as CodecksProfile;
    this.taskPrevious = undefined;
  }

  get profile(): CodecksProfile { return this.selected; }

  select(profile: CodecksProfile, scope: ProfileScope): void {
    if (profile !== "ORG" && profile !== "PERSONAL") throw new Error("Only ORG and PERSONAL profiles are supported.");
    if (scope !== "task" && scope !== "session") throw new Error("Profile scope must be task or session.");
    if (scope === "task" && this.taskPrevious === undefined) this.taskPrevious = this.selected;
    if (scope === "session") this.taskPrevious = undefined;
    this.selected = profile;
  }

  settle(): void {
    if (this.taskPrevious !== undefined) this.selected = this.taskPrevious;
    this.taskPrevious = undefined;
  }
}

/** PERSONAL must not accidentally inherit the ORG/global secret in a single-reference setup. */
export function isProfileConfigured(profile: CodecksProfile, env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = env.CODECKS_CREDENTIAL_PROVIDER ?? "environment";
  if (provider === "onepassword") return Boolean((profile === "PERSONAL"
    ? env.CODECKS_PROFILE_PERSONAL_ONEPASSWORD_REFERENCE
    : env.CODECKS_PROFILE_ORG_ONEPASSWORD_REFERENCE ?? env.PI_CODECKS_ONEPASSWORD_REFERENCE)?.trim());
  if (provider === "environment") return Boolean((profile === "PERSONAL"
    ? env.CODECKS_PROFILE_PERSONAL_TOKEN ?? env.CODECKS_PROFILE_PERSONAL_API_TOKEN
    : env.CODECKS_PROFILE_ORG_TOKEN ?? env.CODECKS_PROFILE_ORG_API_TOKEN ?? env.CODECKS_TOKEN ?? env.CODECKS_API_TOKEN)?.trim());
  return provider === "external-helper" && Boolean(env.CODECKS_CREDENTIAL_HELPER_MODULE?.trim());
}
