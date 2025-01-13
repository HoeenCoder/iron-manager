import { IEvent } from '../common';
import * as Discord from 'discord.js';
import { DeploymentActivityLogger } from '../logger';
import { Config } from '../common';

const events: {[key: string]: IEvent} = {
    deployment_voice_monitor: {
        name: Discord.Events.VoiceStateUpdate,
        async execute(oldState: Discord.VoiceState, newState: Discord.VoiceState) {
            if (!oldState.member || !newState.member) return; // No member
            if (oldState.channelId === newState.channelId) return; // No channel change
            if (!oldState.channel && !newState.channel) return; // Double null channel

            const oldActive = oldState.channel !== null && oldState.channel.parentId === Config.voice_category_id;
            const newActive = newState.channel !== null && newState.channel.parentId === Config.voice_category_id;
            if (oldActive === newActive) return; // Swapped between two channels in the same category group, ignore

            const key = await DeploymentActivityLogger.dataManager.lock();
            if (DeploymentActivityLogger.dataManager.isDeploymentActive(key)) {
                if (!oldActive && newActive) {
                    // Join
                    DeploymentActivityLogger.dataManager.reportJoin(key, newState.member.id);
                } else {
                    // Leave
                    DeploymentActivityLogger.dataManager.reportLeave(key, oldState.member.id);
                }
            }
            await DeploymentActivityLogger.dataManager.unlock(key);
        }
    }
};

module.exports = events;
