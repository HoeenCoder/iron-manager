import fs = require('fs');
import Luxon = require('luxon');
import { Config, getGuild, getFileName } from './common';
import * as Discord from 'discord.js';

/**
 * Manages IRON logging
 */
export namespace IronLogger {
    export type IronAchivementType = 'deployment' | 'commendation';

    export interface MemberWeeklyIronLog {
        deployment?: true;
        commendation?: true;
    }

    interface IronJSON {
        weekTimestamp: number;
        members: {
            [member: string]: MemberWeeklyIronLog
        }
    }

    // on boot setup
    const fileLoc = `${__dirname}/../storage/${getFileName('iron')}.json`;
    let iron: IronJSON;
    if (!fs.existsSync(fileLoc)) {
        iron = {
            weekTimestamp: calcCurWeekTimestamp(),
            members: {}
        };

        writeJSON();
    } else {
        iron = JSON.parse(fs.readFileSync(fileLoc, {encoding: 'utf-8'}));
        validateData();
    }

    /**
     * Checks if the stored data is still valid (a new week has not started).
     * If it has, update it.
     */
    function validateData() {
        let weekStart = calcCurWeekTimestamp();
        if (iron.weekTimestamp === weekStart) {
            // Week has not changed since last check
            return;
        }

        // Update timestamp, wipe values
        iron.weekTimestamp = weekStart;
        iron.members = {};

        writeJSON();
        console.log(`[NOTICE] New week detected, iron reset.`);
    }

    /**
     * Gets the timestamp for when this week started.
     * @returns The most recent Tuesday at 12:00 AM UTC as a millisecond timestamp
     */
    function calcCurWeekTimestamp(): number {
        let now = Luxon.DateTime.utc().startOf('day');
        if (now.weekday === 1) {
            now = now.minus({ days: 1});
        }

        return now.set({weekday: 2}).toMillis();
    }

    /**
     * Writes changes to JSON
     */
    function writeJSON() {
        fs.writeFileSync(fileLoc, JSON.stringify(iron), {encoding: 'utf-8'});
    }

    /**
     * Gets the timestamp for the start of the current week
     * @returns the timestamp in milliseconds since 1/1/1970 @ 12:00 AM UTC
     */
    export function getCurrentWeekTimestamp(): number {
        validateData();
        return iron.weekTimestamp;
    }

    /**
     * Gets IRON data for a specific member.
     * Data indicates if the member has earned iron via deployment and/or commendation this week.
     * @param memberID Discord snowflake user ID
     * @param verificationTimestamp Timestamp for the start of the week obtained from getCurrentWeekTimestamp. Used to ensure data integrity.
     * @returns The member's iron data
     */
    export function readIron(memberID: string, verificationTimestamp: number): MemberWeeklyIronLog {
        validateData();
        if (iron.weekTimestamp !== verificationTimestamp) {
            throw new Error(`Invalid verification timestamp! IRON Data has likely changed!`);
        }

        return iron.members[memberID] || {};
    }

    /**
     * Writes IRON data for a set of members as a batch.
     * Data indicates if the member has earned iron via deployment and/or commendation this week.
     * @param members Array of Discord snowflake user IDs
     * @param type The type of deployment to mark this user as having taken part in.
     * @param verificationTimestamp Timestamp for the start of the week obtained from getCurrentWeekTimestamp. Used to ensure data integrity.
     */
    export function writeIron(members: string[], type: IronAchivementType, verificationTimestamp: number) {
        validateData();
        if (iron.weekTimestamp !== verificationTimestamp) {
            throw new Error(`Invalid verification timestamp! IRON Data has likely changed!`);
        }

        for (let m of members) {
            if (!iron.members[m]) iron.members[m] = {};
            iron.members[m][type] = true;
        }

        writeJSON();
    }

    /**
     * Only works with dev mode enabled.
     * Clears IRON data on request.
     */
    export function resetJSON() {
        if (!process.env.DEV_MODE) return;
        iron.members = {};
        writeJSON();
    }
}

/**
 * General purpose logging functionality
 */
export namespace Logger {
    export function logError(e: any) {
        let errorText = e;
        if (e instanceof Error) {
            errorText = `${(e as Error).message}\n${(e as Error).stack}`;
        }

        console.error(e);
        const timestamp = Luxon.DateTime.utc().toLocaleString(Luxon.DateTime.DATETIME_MED_WITH_SECONDS);
        fs.appendFileSync(`${__dirname}/../storage/${getFileName('errors')}.log`, `${timestamp}: ${errorText}\n\n`, {encoding: 'utf-8'});
    }

    export async function logToChannel(msg: string) {
        console.log(`[NOTICE] ${msg}`);
        const timestamp = Luxon.DateTime.utc().toLocaleString(Luxon.DateTime.DATETIME_MED_WITH_SECONDS);
        fs.appendFileSync(`${__dirname}/../storage/${getFileName('notices')}.log`, `${timestamp}: ${msg}\n\n`, {encoding: 'utf-8'});

        const guild = await getGuild();
        if (!guild) return; // weird...

        const channel = await guild.channels.fetch(Config.log_channel_id);
        if (!channel || !channel.isSendable()) return;

        channel.send(msg);
    }

    export async function logEmbedToChannel(embed: Discord.EmbedBuilder) {
        const timestamp = Luxon.DateTime.utc().toLocaleString(Luxon.DateTime.DATETIME_MED_WITH_SECONDS);
        fs.appendFileSync(`${__dirname}/../storage/${getFileName('notices')}.log`, `${timestamp}: ${JSON.stringify(embed.data)}\n\n`, {encoding: 'utf-8'});
        console.log(`[NOTICE] Embed titled "${embed.data.title}" logged to ${getFileName('notices')}.log`);

        const guild = await getGuild();
        if (!guild) return; // weird...

        const channel = await guild.channels.fetch(Config.log_channel_id);
        if (!channel || !channel.isSendable()) return;

        channel.send({embeds: [embed]});
    }
}
