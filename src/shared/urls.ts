import { getBaseConfig } from "../runtime/credentials";

export const formatCardUrl = (shortCode?: string): string =>
{
    if (!shortCode)
    {
        return "";
    }

    const config = getBaseConfig();
    return `https://${config.account}.codecks.io/card/${shortCode.replace("$", "")}`;
};

export const formatRunUrl = (accountSeq?: number): string =>
{
    if (accountSeq === undefined)
    {
        return "";
    }

    const config = getBaseConfig();
    return `https://${config.account}.codecks.io/sprint/${accountSeq}`;
};

export const formatMilestoneUrl = (accountSeq?: number): string =>
{
    if (accountSeq === undefined)
    {
        return "";
    }

    const config = getBaseConfig();
    return `https://${config.account}.codecks.io/milestones/${accountSeq}`;
};
