/**
 * Module for managing the issuing of iron to members
 */
import RomanNumerals = require('roman-numerals');
import * as Discord from 'discord.js';
import { IronLogger, Logger } from './logger';
import { Config } from './common';

export interface IronDistributionResults {
    issued: Discord.GuildMember[],
    notIssued: Discord.GuildMember[],
    duplicates: Discord.GuildMember[],
    invalidName: Discord.GuildMember[],
    namePermsError: [Discord.GuildMember, string][],
    rankPermsError: Discord.GuildMember[],
    skippedEnvoys: Discord.GuildMember[],
    commendedForService: Discord.GuildMember[]
}

export let recentlyUpdatedNames: string[] = [];

export async function distributeIron(members: Discord.GuildMember[], type: IronLogger.IronAchivementType): Promise<IronDistributionResults> {
    const key = await IronLogger.dataManager.lock();
    const completedIDs: string[] = [];
    const results: IronDistributionResults = {
        issued: [],
        notIssued: [],
        duplicates: [],
        invalidName: [],
        namePermsError: [],
        rankPermsError: [],
        skippedEnvoys: [],
        commendedForService: []
    };
    const attemptTo = {
        issue: ([] as Discord.GuildMember[]),
        commend: ([] as Discord.GuildMember[]),
        markParticipated: ([] as Discord.GuildMember[])
    };

    for (let member of members) {
        if (completedIDs.includes(member.id)) {
            results.duplicates.push(member);
            continue;
        }

        try {
            if (isEnvoy(member)) {
               results.skippedEnvoys.push(member);
               completedIDs.push(member.id);
               continue;
            }
        } catch (e) {
            // should never happen, can't throw here safely.
            await Logger.logToChannel(`Invalid name when attempting to check envoy status during iron distribution!\n\n` +
                `Name: ${member.displayName}.\n\nListing user as having an invalid name in results.`
            );
            results.invalidName.push(member);
            completedIDs.push(member.id);
            continue;
        }

        if (!parseUsername(member.displayName)) {
            // Name in bad format, cancel distribution, ask for human intervention
            results.invalidName.push(member);
            continue;
        }

        const data = IronLogger.dataManager.readIron(key, member.id);
        if (data[type]) {
            // Already got iron
            results.notIssued.push(member);
        } else {
            // Issue iron, specifically iron will be issued after JSON is updated
            attemptTo.issue.push(member);
        }

        // Track the number of deployments regardless
        if (type === 'deployment') {
            attemptTo.markParticipated.push(member);
            if (data.numDeployments >= 4 && !data.commendation) {
                // Attempt to issue an automatic commendation for attending 5+ MODs in a week
                // We check for >= 4 here because that value is incremented below when we write IRON.
                // Its about to be incremented as its a deployment, we just want to do all the writes
                // in one big batch and be done with it.
                attemptTo.commend.push(member);
            }
        }
        completedIDs.push(member.id);
    }

    // Write data and end transaction
    IronLogger.dataManager.writeIron(key, attemptTo.issue.map(m => m.id), type);
    IronLogger.dataManager.incrementDeploymentTracker(key, attemptTo.markParticipated.map(m => m.id));
    if (attemptTo.commend.length) {
        IronLogger.dataManager.writeIron(key, attemptTo.commend.map(m => m.id), 'commendation');
    }
    await IronLogger.dataManager.unlock(key);

    // Update usernames, ranks
    recentlyUpdatedNames = [];
    for (let member of attemptTo.issue.concat(attemptTo.commend)) {
        const parsed = parseUsername(member.displayName);
        if (!parsed) {
            // should never happen, can't throw here safely.
            await Logger.logToChannel(`Invalid name when attempting to issue iron! Name: ${member.displayName}.\n\n` +
                `Please fix their username and manually increase their IRON count by 1 (via nickname editing).`
            );
            continue;
        }
        if (parsed[0] < 0) {
            // Should never happen, but just in case
            await Logger.logToChannel(`Attempted to issue IRON to envoy! Name: ${member.displayName}.\n\n` +
                `IRON was not issued. This should not happen, contact a maintainer.`
            );
        } else {
            parsed[0]++;
        }

        const username = createUsername(...parsed);
        if (!member.manageable) {
            const newNumerals = parsed[0] <= 500 && parsed[0] > 0 ? RomanNumerals.toRoman(parsed[0]) : parsed[0] + '';
            results.namePermsError.push([member, newNumerals]);
            continue;
        }
        recentlyUpdatedNames.push(member.id);
        await member.setNickname(username).catch((e) => {
            // Should never happen but OK, we can't crash here, handle it the best we can.
            Logger.logToChannel(`Error when attempting to issue iron! Target username: ${username}.\n\n` +
                `Please set their username to the one provided above (via nickname editing).`
            );
            Logger.logError(e);
        });

        // Try to promote, if an error occurs due to permissions...
        if (await tryPromotion(member, '' + parsed[0])) {
            results.rankPermsError.push(member);
            continue;
        }

        if (attemptTo.commend.includes(member)) {
            // Mark as having been commended
            // Its not possible to both earn a commendation for participation
            // and earn deployment IRON at the exact same time, we don't need to check that.
            results.commendedForService.push(member);
        } else {
            results.issued.push(member);
        }
    }
    recentlyUpdatedNames = [];

    return results;
}

/**
 * Extract IRON value and name from a username.
 * Envoys (E) do not have IRON but are treated as a negative value
 * for compatability (-10).
 * @param username The username to parse in the format of [ IRON ] name
 * @returns [IRON value, username]
 */
function parseUsername(username: string): [number, string] | null {
    // "[ XVII ] Example Name" -> [17, "Example Name"]
    // "[ E ] Example Name" -> [-10, "Example Name"]
    const matches = username.match(/^\[ ?((?:[IVXLCDME]|[0-9])+) ?\] (.+)$/i);
    if (!matches || (matches[1] !== 'E' && matches[1].includes('E'))) {
        // bad username format
        return null;
    }

    if (matches[1] === 'E') {
        // Envoy status
        return [-10, matches[2]];
    }

    let numeral;
    try {
        numeral = RomanNumerals.toArabic(matches[1]);
    } catch (e) {
        // is this a normal number instead?
        numeral = parseInt(matches[1]);
        if (isNaN(numeral)) {
            // Bad numeral
            return null;
        }
    }

    return [numeral, matches[2]];
}

/**
 * Creates a combined username from an IRON value and username.
 * Negative IRON values are used for Enovys and become E.
 * @param iron User's IRON value
 * @param name User's name
 * @returns User's combined name in the form of [ IRON ] name
 */
export function createUsername(iron: number, name: string): string {
    // 17, "Example Name" -> "[ XVII ] Example Name"
    // -10, "Example Name" -> "[ E ] Example Name"
    if (iron < -10) {
        throw new Error(`IRON count when assembling username was invalid. name: ${name}, iron: ${iron}`);
    }

    let numerals: string;
    if (iron > 0 && iron <= 500) {
        numerals = RomanNumerals.toRoman(iron);
    } else if (iron < 0) {
        numerals = 'E';
    } else {
        numerals = iron + '';
    }

    // length check
    let length = 5 + numerals.length + name.length;
    if (length <= 32) {
        // Ok for [ IRON ] NAME
        return `[ ${numerals} ] ${name}`;
    } else if (length - 2 <= 32) {
        // Use [IRON] NAME
        return `[${numerals}] ${name}`;
    } else {
        // try using decimal instead of roman numerals
        length = 5 + ('' + iron).length + name.length;
        if (length <= 32) {
            // Use [ IRON ] NAME
            return `[ ${iron} ] ${name}`;
        } else {
            // Use [IRON] NAME, trim to 32 chars if over 32
            return `[${iron}] ${name}`.substring(0, 32);
        }
    }
}

/**
 * See if a member who just received iron should be promoted and if so promote them.
 * @param member Guild member to check a promotion for
 * @param ironCount Member's new iron count
 * @returns true if an error occurs, false if not.
 */
export async function tryPromotion(member: Discord.GuildMember, ironCount: string): Promise<boolean> {
    // 1. Check to see if theres a promotion to perform
    if (!Object.keys(Config.ranks).includes(ironCount)) return false; // No promotion at this iron count
    const rank = Config.ranks[ironCount];

    // 2. Validate the user has the required role(s)
    if (!member.roles.cache.hasAll(...rank.required)) {
        // Member lacks one or more required roles
        return false;
    }

    // 3. Check if the bot can manage this user
    if (!member.manageable) {
        return true;
    }

    // 4. Update roles
    const roleManager = member.guild.roles;
    const changingRoles = rank.add.concat(rank.remove);

    for (const r of changingRoles) {
        const role = await roleManager.fetch(r);
        if (!role || !role.editable) {
            return true;
        }
    }

    const roles = Object.keys(member.roles.cache);
    // Update member's roles
    for (const role of rank.remove) {
        if (roles.includes(role)) {
            roles.splice(roles.indexOf(role), 1);
        }
    }
    for (const role of rank.add) {
        if (!roles.includes(role)) {
            roles.push(role);
        }
    }

    // One set call to mitigate a rare API race condition
    await member.roles.set(roles);

    return false;
}

/**
 * Determines if a user is an envoy (has an IRON value of E).
 * @param member The guild member to check
 * @returns true if envoy, false if not
 */
export function isEnvoy(member: Discord.GuildMember): boolean {
    const parsed = parseUsername(member.displayName);
    if (!parsed) {
        // Should never happen but...
        throw new Error(`Unable to parse username when determining if user is envoy.`);
    }

    return parsed[0] < 0;

}
