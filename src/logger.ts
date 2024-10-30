import fs = require('fs');
import Luxon = require('luxon');
import { Config, getGuild, getFileName } from './common';
import * as Discord from 'discord.js';
import crypto = require('crypto');

const LOCK_TIMEOUT = 1000 * 60; // 1 minute

/**
 * Prevents race conditions when accessing data
 */
abstract class Lock {
    private locked: string = '';
    private waiting: ((value: string) => void)[] = [];
    private timeout: NodeJS.Timeout | null = null;

    /**
     * Locks the relevant data making all other requests wait for this one to finish.
     * This method will return the transaction key when the data becomes avaliable.
     * You MUST unlock the data with a call to unlock before the transaction times out.
     * @returns Transaction key required for most actions on the data.
     */
    async lock(): Promise<string> {
        if (this.locked) {
            return new Promise<string>((resolver) => {
                this.waiting.push(resolver);
            });
        } else {
            this.locked = crypto.randomUUID();
            this.timeout = setTimeout(async () => {
                await this.unlock(this.locked);
                throw new Error(`Transaction exceeded maximum time limit of ${LOCK_TIMEOUT / 1000} seconds.`);
            }, LOCK_TIMEOUT);
            return new Promise<string>((resolver) => {
                resolver(this.locked);
            });
        }
    }

    /**
     * Releases a transactional lock, requires the key created when locking the data.
     * The key will be invalidated by this action, if you need to read or modify the data
     * again, obtain a new lock.
     * @param key Transaction key required for most actions on the data.
     */
    async unlock(key: string) {
        this.tryKey(key);
        if (this.timeout) {
            clearTimeout(this.timeout);
            this.timeout = null;
        }

        if (this.waiting.length) {
            const resolver = this.waiting.shift() as ((value: string) => void);
            this.locked = crypto.randomUUID();
            this.timeout = setTimeout(async () => {
                await this.unlock(this.locked);
                throw new Error(`Transaction exceeded maximum time limit of ${LOCK_TIMEOUT / 1000} seconds.`);
            }, LOCK_TIMEOUT);
            resolver(this.locked);
        } else {
            this.locked = '';
        }
    }

    /**
     * Validate the provided transaction key. Throws an error if invalid, silently returns if valid.
     * @param key Transaction key required for most actions on the data.
     */
    protected tryKey(key: string): void {
        if (!this.locked || this.locked !== key) {
            throw new Error(`Lock violation: ${this.locked ? 'bad key' : 'not locked'}.`);
        }
    }
}

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

    class IronLock extends Lock {
        private fileLoc: string;
        private iron: IronJSON;

        constructor() {
            super();
            this.fileLoc = `${__dirname}/../storage/${getFileName('iron')}.json`;

            if (!fs.existsSync(this.fileLoc)) {
                this.iron = {
                    weekTimestamp: this.calcCurWeekTimestamp(),
                    members: {}
                };

                fs.writeFileSync(this.fileLoc, JSON.stringify(this.iron), {encoding: 'utf-8'});
            } else {
                this.iron = JSON.parse(fs.readFileSync(this.fileLoc, {encoding: 'utf-8'}));
            }
        }

        /**
         * Overriden version of Lock's lock method to insert data validation when a transaction starts.
         * Obtains the key first (super.lock()) THEN validates and returns it.
         * @returns Transaction key required for most actions on the data.
         */
        async lock(): Promise<string> {
            const key = await super.lock();
            this.validateData(key);
            return key;
        }

        /**
         * Internal method that handles the deployment week changing.
         * @param key The transaction key to ensure the method caller holds the lock for this data.
         */
        private validateData(key: string): void {
            this.tryKey(key);

            let weekStart = this.calcCurWeekTimestamp();
            if (this.iron.weekTimestamp === weekStart) {
                // Week has not changed since last check
                return;
            }

            // Update timestamp, wipe values
            this.iron.weekTimestamp = weekStart;
            this.iron.members = {};

            this.writeJSON();
            console.log(`[NOTICE] New week detected, iron reset.`);
        }

        /**
         * Internal method to calculate the current week's weekly timestamp.
         * @returns The unix timestamp representing the start of the current deployment week.
         */
        private calcCurWeekTimestamp(): number {
            let now = Luxon.DateTime.utc().startOf('day');
            if (now.weekday === 1) {
                now = now.minus({ days: 1});
            }

            return now.set({weekday: 2}).toMillis();
        }

        /**
        * Gets IRON data for a specific member.
        * Data indicates if the member has earned iron via deployment and/or commendation this week.
        * @param key The transaction key to ensure the method caller holds the lock for this data.
        * @param memberID Discord snowflake user ID
        * @returns The member's iron data
        */
        readIron(key: string, memberID: string): MemberWeeklyIronLog {
            this.tryKey(key);

            return this.iron.members[memberID] || {};
        }

        /**
         * Writes IRON data for a set of members as a batch.
         * Data indicates if the member has earned iron via deployment and/or commendation this week.
         * @param key The transaction key to ensure the method caller holds the lock for this data.
         * @param members Array of Discord snowflake user IDs
         * @param type The type of deployment to mark this user as having taken part in.
         */
        writeIron(key: string, members: string[], type: IronAchivementType): void {
            this.tryKey(key);

            for (let m of members) {
                if (!this.iron.members[m]) this.iron.members[m] = {};
                this.iron.members[m][type] = true;
            }

            this.writeJSON();
        }

        /**
         * Obtain the current week's timestamp. Data is validated when this is requested.
         * @param key The transaction key to ensure the method caller holds the lock for this data.
         * @returns The current week's timestamp.
         */
        async getCurrentWeekTimestamp(key: string): Promise<number> {
            // tryKey called in validateData
            this.validateData(key);

            return this.iron.weekTimestamp;
        }

        /**
         * Resets IRON data as if a new week started. Only avaliable in dev mode.
         * @param key The transaction key to ensure the method caller holds the lock for this data.
         */
        resetIron(key: string) {
            if (!process.env.DEV_MOD) {
                throw new Error(`Attempted to reset IRON outside of dev mode.`);
            }
            this.tryKey(key);

            this.iron = {
                weekTimestamp: this.calcCurWeekTimestamp(),
                members: {}
            };
            this.writeJSON();
        }

        /**
         * Internal method to perform the actual JSON write.
         */
        private writeJSON(): void {
            // Key not required because this is used internally only
            fs.writeFileSync(this.fileLoc, JSON.stringify(this.iron), {encoding: 'utf-8'});
        }
    }

    export const transactionManager = new IronLock();
}

/**
 * Manages deployment voice activity logging
 */
export namespace DeploymentActivityLogger {
    interface DeploymentActivityJSON {
        active: boolean,
        members: {[memberId: string]: MemberDeploymentActivityRecord}
    }

    export interface MemberDeploymentActivityRecord {
        joined: number | null
        totalTime: number
    }

    export interface DeploymentQualificationRecord {
        qualified: string[],
        particpated: string[]
    }

    export const MINIMUM_TIME_TO_QUALIFY = 1000 * 60 * 60; // 1 hour

    class DeploymentActivityLock extends Lock {
        private fileLoc: string;
        private activityRecords: DeploymentActivityJSON;
        private recoveryRequired: boolean = false;

        constructor() {
            super();
            this.fileLoc = `${__dirname}/../storage/${getFileName('deployment-voice')}.json`;

            if (!fs.existsSync(this.fileLoc)) {
                this.activityRecords = {
                    active: false,
                    members: {}
                };

                fs.writeFileSync(this.fileLoc, JSON.stringify(this.activityRecords), {encoding: 'utf-8'});
            } else {
                this.activityRecords = JSON.parse(fs.readFileSync(this.fileLoc, {encoding: 'utf-8'}));
            }

            if (this.activityRecords.active) {
                this.recoveryRequired = true;
            }
        }

        async runRecovery(): Promise<void> {
            if (!this.recoveryRequired) return;
            this.recoveryRequired = false;
            const key = await this.lock();
            const inactiveIds = Object.keys(this.activityRecords.members);

            // 1. Ensure all members activly in VC are marked as active
            const guild = await getGuild();
            if (!guild || !guild.available) {
                // Something is wrong...
                throw new Error('Unable to find guild when recovering deployment activity logger after a reboot.');
            }

            const voiceCategory = await guild.channels.fetch(Config.voice_category_id);
            if (!voiceCategory) return;
            if (voiceCategory.type !== Discord.ChannelType.GuildCategory) {
                throw new Error(`When performing deployment activity recovery, voice channel category is not a category. ID: ${Config.voice_category_id}`);
            }

            for (const [channelId, channel] of voiceCategory.children.cache) {
                if (channel.type !== Discord.ChannelType.GuildVoice || channel.members.size < 1) continue;

                for (const [memberId, member] of channel.members) {
                    const idx = inactiveIds.indexOf(member.id);
                    if (idx >= 0) {
                        inactiveIds.splice(idx, 1);
                    }

                    if (!this.activityRecords.members[member.id]) {
                        this.activityRecords.members[member.id] = {joined: null, totalTime: 0};
                    }

                    if (!this.activityRecords.members[member.id].joined) {
                        this.activityRecords.members[member.id].joined = Date.now();
                    }
                }
            }

            // 2. Ensure all records not in VC are marked as inactive
            for (const memberId of inactiveIds) {
                if (this.activityRecords.members[memberId].joined) {
                    this.activityRecords.members[memberId].totalTime +=
                        Date.now() - this.activityRecords.members[memberId].joined;
                    this.activityRecords.members[memberId].joined = null;
                }
            }

            // 3. Write data, release lock
            this.writeJSON();
            await this.unlock(key);
        }

        reportJoin(key: string, memberId: string) {
            this.tryKey(key);
            if (!this.activityRecords.members[memberId]) {
                this.activityRecords.members[memberId] = {
                    joined: null,
                    totalTime: 0
                };
            }

            if (this.activityRecords.members[memberId].joined) {
                throw new Error(`Join reported when user is already marked as active`);
            }

            this.activityRecords.members[memberId].joined = Date.now();
            this.writeJSON();
        }

        reportLeave(key: string, memberId: string) {
            this.tryKey(key);
            if (!this.activityRecords.members[memberId]) {
                this.activityRecords.members[memberId] = {
                    joined: null,
                    totalTime: 0
                };
            }

            if (!this.activityRecords.members[memberId].joined) {
                throw new Error(`Leave reported when user isn't marked as active`);
            }

            this.activityRecords.members[memberId].totalTime += Date.now() - this.activityRecords.members[memberId].joined;
            this.activityRecords.members[memberId].joined = null;
            this.writeJSON();
        }

        isDeploymentActive(key: string): boolean {
            this.tryKey(key);
            return this.activityRecords.active;
        }

        async startDeployment(key: string) {
            this.tryKey(key);
            if (this.activityRecords.active) {
                throw new Error(`Attempting to start a deployment while one is already running.`);
            }
            this.resetJSON();

            // Detect members who are already deployed
            const guild = await getGuild();
            if (!guild || !guild.available) {
                // Something is wrong...
                throw new Error('Unable to find guild when starting deployment.');
            }

            const voiceCategory = await guild.channels.fetch(Config.voice_category_id);
            if (!voiceCategory) return;
            if (voiceCategory.type !== Discord.ChannelType.GuildCategory) {
                throw new Error(`When performing starting deployment, voice channel category is not a category. ID: ${Config.voice_category_id}`);
            }

            for (const [channelId, channel] of voiceCategory.children.cache) {
                if (channel.type !== Discord.ChannelType.GuildVoice || channel.members.size < 1) continue;

                for (const [memberId, member] of channel.members) {
                    if (!this.activityRecords.members[member.id]) {
                        this.activityRecords.members[member.id] = {joined: null, totalTime: 0};
                    }

                    if (!this.activityRecords.members[member.id].joined) {
                        this.activityRecords.members[member.id].joined = Date.now();
                    }
                }
            }

            this.activityRecords.active = true;
        }

        endDeployment(key: string) {
            this.tryKey(key);
            if (!this.activityRecords.active) {
                throw new Error(`Attempting to end a deployment while one isn't running.`);
            }

            this.activityRecords.active = false;
            const endTime = Date.now();
            for (const memberId in this.activityRecords.members) {
                if (this.activityRecords.members[memberId].joined) {
                    this.activityRecords.members[memberId].totalTime +=
                        endTime - this.activityRecords.members[memberId].joined;
                    this.activityRecords.members[memberId].joined = null;
                }
            }
            this.writeJSON();
        }

        getQualifiedMembers(key: string): DeploymentQualificationRecord {
            this.tryKey(key);

            const results: DeploymentQualificationRecord = {
                qualified: [],
                particpated: []
            };

            for (let memberId in this.activityRecords.members) {
                const record = this.activityRecords.members[memberId];
                let time = record.totalTime;
                if (record.joined) {
                    time += Date.now() - record.joined;
                }

                if (time >= MINIMUM_TIME_TO_QUALIFY) {
                    results.qualified.push(memberId);
                } else {
                    results.particpated.push(memberId);
                }
            }

            return results;
        }

        getMemberData(key: string, memberId: string): MemberDeploymentActivityRecord | null {
            this.tryKey(key);
            return this.activityRecords.members[memberId] || null;
        }

        private resetJSON() {
            this.activityRecords = {
                active: false,
                members: {}
            };

            this.writeJSON();
        }

        private writeJSON() {
            fs.writeFileSync(this.fileLoc, JSON.stringify(this.activityRecords), {encoding: 'utf-8'});
        }
    }

    export const transactionManager = new DeploymentActivityLock();
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
