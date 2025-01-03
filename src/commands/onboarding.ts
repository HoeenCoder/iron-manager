import * as Discord from "discord.js";
import { ICommand, roleBasedPermissionCheck, IConfig, Config, getGuild } from "../common";
import { Logger, OnboardingLogger } from '../logger';
import { createUsername, tryPromotion } from "../iron-manager";

// rejectorId -> [rejecteeId, applicationMessageId]
const rejectionTable: {[rejectorId: string]: string[]} = {};
const flagTable: {[flaggerId: string]: string} = {};

// Standard button row, frequently used
const onboardingButtonRow = new Discord.ActionRowBuilder<Discord.ButtonBuilder>()
    .addComponents(
        new Discord.ButtonBuilder()
            .setCustomId('onboarding-applicant-approve')
            .setLabel('Approve')
            .setStyle(Discord.ButtonStyle.Success),
        new Discord.ButtonBuilder()
            .setCustomId('onboarding-applicant-reject')
            .setLabel('Reject')
            .setStyle(Discord.ButtonStyle.Danger),
        new Discord.ButtonBuilder()
            .setCustomId('onboarding-applicant-envoy')
            .setLabel('Approve as Envoy')
            .setStyle(Discord.ButtonStyle.Primary),
        new Discord.ButtonBuilder()
            .setCustomId('onboarding-applicant-flag')
            .setLabel('Flag for Review')
            .setStyle(Discord.ButtonStyle.Secondary),
        new Discord.ButtonBuilder()
            .setCustomId('onboarding-applicant-close')
            .setLabel('Close Without Approving or Rejecting')
            .setStyle(Discord.ButtonStyle.Secondary));

/**
 * Get the forum channel where applications are posted.
 * @returns Forum channel where applications are posted.
 */
async function getApplicationForum(): Promise<Discord.ForumChannel> {
    const guild = await getGuild();
    if (!guild) {
        throw new Error(`Guild not found!`);
    }

    const onboardingChannel = await guild.channels.fetch(Config.onboarding_forum_id);
    if (!onboardingChannel || !(onboardingChannel instanceof Discord.ForumChannel)) {
        Logger.logToChannel(`Onboarding submission received but no sendable onboarding forum is configured! Please configure the onboarding forum!`);
        throw new Error(`Onboarding forum not found!`);
    }

    return onboardingChannel;
}

/**
 * Get a forum thread for an applicatant.
 * @param member the member to get a thread for.
 * @returns the application thread for this member, or null if none exists.
 */
async function getApplicantThread(member: Discord.GuildMember): Promise<Discord.ForumThreadChannel | null> {
    const onboardingChannel = await getApplicationForum();

    const threadPools = [
        (await onboardingChannel.threads.fetchActive()).threads,
        (await onboardingChannel.threads.fetchArchived()).threads
    ];

    for (const pool of threadPools) {
        for (const [id, t] of pool) {
            // Safe cast, were working with a forum
            const thread = (t as Discord.ForumThreadChannel);
            if (!thread.name.startsWith(`[${member.id}]`))
                continue;

            // Thread found!
            return thread;
        }
    }

    // No channel found
    return null;
}

/**
 * Updates a thread's tag and archive status based on tag.
 * @param thread The thread to update the tag for.
 * @param tag A valid tag to apply.
 */
async function setThreadTag(thread: Discord.ForumThreadChannel, tag: keyof IConfig["onboarding"]["tags"]) {
    if (["pending", "flagged"].includes(tag)) {
        // Ensure active
        await thread.setArchived(false);
        await thread.setAppliedTags([Config.onboarding.tags[tag]]);
    } else {
        if (thread.archived) {
            // Should be very rare, but is possible. Just un-archive it first.
            await thread.setArchived(false);
        }
        await thread.setAppliedTags([Config.onboarding.tags[tag]]);
        await thread.setArchived(true);
    }
}

/**
 * Approve an application. Most logic is used in multiple places and therefore is split out to this method.
 * @param interaction The ButtonIntercation triggering the approval.
 * @param rankCategory The category to assign the user to.
 */
async function approveApplicant(interaction: Discord.ButtonInteraction, rankCategory: '0' | 'E') {
    // 1. Validation
    const guild = await getGuild();
    if (!guild) {
        throw new Error(`Guild not found!`);
    }

    const userMention = interaction.message.embeds[0].fields.find(f => f.name === 'Account')?.value || '';
    const userId = (userMention.match(/<@([0-9]+)>/) || [])[1];
    let applicant: Discord.GuildMember;

    try {
        applicant = await guild.members.fetch(userId);
    } catch (e) {
        await interaction.followUp({
            content: `Could not find applicant to approve, did they leave the server?\n\n` +
                `You can delete this application with the "Delete Application" button.`,
            ephemeral: true
        });
        return;
    }

    // Ensure applicant wasn't already approved/rejected.
    if (!applicant.roles.cache.hasAny(...Config.ranks[rankCategory].required)) {
        await interaction.followUp({
            content: `Applicant does not have the role(s) new recruits have, maybe they were already approved or rejected?\n\n` +
                `You can delete this application with the "Delete Application" button.`,
            ephemeral: true,
        });
        return;
    }

    const ingameName = interaction.message.embeds[0].fields.find(f => f.name === 'In-Game Name')?.value || '';
    if (!ingameName) {
        throw new Error(`When onboarding, could not find applicant's in-game name!`);
    }

    const dataSets: {category: string, userInput: string, matchers: {[key: string]: RegExp}}[] = [
        {
            category: 'Platform',
            userInput: interaction.message.embeds[0].fields.find(f => f.name === 'Platform')?.value || '',
            matchers: {
                'playstation': /(?:ps(?:4|5)?(?: pro)?|playstation)/i,
                'steam': /(?:pc|steam(?: ?deck)?)/i
            }
        },
        {
            category: 'Continent',
            userInput: interaction.message.embeds[0].fields.find(f => f.name === 'Continent')?.value || '',
            matchers: {
                'northAmerica': /(?:north ?america|na)/i,
                'southAmerica': /(?:south ?america|sa)/i,
                'europe': /(?:europe|eu)/i,
                'oceania': /(?:oceania|oc|australia|aus)/i,
                'asia': /(?:asia|as)/i,
                'africa': /(?:africa|af)/i
                //'antartica': /(?:antartica|an)/i
            }
        }
    ];

    const problemEmbed = new Discord.EmbedBuilder()
        .setColor(0x6c1313)
        .setTitle(`Onboarding Problems`)
        .setDescription(`Please manually assign roles for these categories to this user.`)
        .addFields(
            {name: `Account`, value: userMention}
        ).setTimestamp()
        .setFooter({text: `When fixed, click the button below this message to dismiss this message.`});

    if (Config.thumbnail_icon_url) problemEmbed.setThumbnail(Config.thumbnail_icon_url);

    // Role validation
    const newRoles: Discord.Role[] = [];

    for (let dataSet of dataSets) {
        const userInput = dataSet.userInput;
        const roleSet = dataSet.matchers;
        let roleId: string | undefined = '';
        for (let key in roleSet) {
            if (userInput.match(roleSet[key])) {
                roleId = key;
                break;
            }
        }

        if (!roleId || !applicant.manageable) {
            problemEmbed.addFields({name: dataSet.category, value: userInput});
        } else {
            if (!Config.onboarding.roles[roleId]) {
                throw new Error(`Onboarding role for ${roleId} not configured!`);
            }
            const role = await guild.roles.fetch(Config.onboarding.roles[roleId]);
            if (!role || !role.editable) {
                throw new Error(`Onboarding role for ${roleId} not found or the bot cannot assign it!`);
            }
            newRoles.push(role);
        }
    }

    // 2. Assign roles, update name
    const username = createUsername(0, ingameName);
    if (applicant.manageable) {
        await applicant.setNickname(username);
    } else {
        problemEmbed.addFields({name: 'Set Nickname To', value: username});
    }

    await applicant.roles.add(newRoles);

    if (await tryPromotion(applicant, rankCategory)) {
        problemEmbed.addFields({name: 'Update Standard Roles',
            value: `Add: ${Config.ranks[0].add.map(r => `<@&${r}>`)}, Remove: ${Config.ranks[0].remove.map(r => `<@&${r}>`)}`});
    }

    const appEmbed = interaction.message.embeds[0];
    const field = appEmbed.fields.find(f => f.name === 'Application Status');
    if (field) {
        field.value = `Approved${rankCategory === 'E' ? ' (as envoy)' : ''} by <@${interaction.user.id}>`;
    }

    // Update embed, post new message if needed
    await interaction.editReply({
        embeds: [appEmbed],
        components: []
    });

    if (problemEmbed.data.fields && problemEmbed.data.fields.length > 1) {
        const buttonRow = new Discord.ActionRowBuilder<Discord.ButtonBuilder>()
            .addComponents(
                new Discord.ButtonBuilder()
                    .setCustomId('onboarding-problems-addressed')
                    .setLabel('Problems Fixed, Dismiss Message')
                    .setStyle(Discord.ButtonStyle.Primary)
            )

        await interaction.followUp({
            embeds: [problemEmbed],
            components: [buttonRow]
        });
    }

    OnboardingLogger.logApproval(applicant, interaction.member as Discord.GuildMember);
    if (interaction.channel?.isThread()) {
        await setThreadTag(interaction.channel as Discord.ForumThreadChannel, "approved");
    }
}

const commands: {[key: string]: ICommand} = {
    'post-onboarding-message': {
        data: new Discord.SlashCommandBuilder()
            .setName('post-onboarding-message')
            .setDescription('Display the message and button to open the onboarding popup. Must be High Command.')
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.Administrator),
        async execute(interaction) {
            if (!roleBasedPermissionCheck('all', interaction.member as Discord.GuildMember)) {
                await interaction.reply({content: `:x: Access Denied. Requires High Command permissions.`, ephemeral: true});
                return;
            }

            const guild = await getGuild();
            if (!guild) {
                throw new Error(`Guild not found!`);
            }

            const onboardingChannel = await guild.channels.fetch(Config.onboarding_forum_id);
            if (!onboardingChannel) {
                await interaction.reply({content: `:x: Could not find onboarding report channel, please make sure its configured!`, ephemeral: true});
                return;
            }

            const button = new Discord.ActionRowBuilder<Discord.ButtonBuilder>()
                .addComponents(
                    new Discord.ButtonBuilder()
                        .setCustomId('start-onboarding-button')
                        .setLabel('Begin Onboarding')
                        .setStyle(Discord.ButtonStyle.Primary))

            await interaction.reply({
                content: `To join the 1st Colonial Regiment, please fill out the onboarding form by clicking this button:`,
                components: [button]
            });
        },
        components: {
            'start-onboarding-button': {
                async execute(interaction) {
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    const modal = new Discord.ModalBuilder()
                        .setCustomId('onboarding-modal')
                        .setTitle('1st Colonial Regiment Onboarding Form')
                        .addComponents(
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-platform')
                                    .setLabel('Do you play on Steam or Playstation?')
                                    .setStyle(Discord.TextInputStyle.Short)
                                    .setMaxLength(11)
                                    .setRequired(true)),
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-in-game-name')
                                    .setLabel('What is your in-game name?')
                                    .setStyle(Discord.TextInputStyle.Short)
                                    .setMaxLength(26)
                                    .setRequired(true)),
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-microphone')
                                    .setLabel('Do you have a microphone?')
                                    .setPlaceholder('Yes or No')
                                    .setStyle(Discord.TextInputStyle.Short)
                                    .setMaxLength(3)
                                    .setRequired(true)),
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-continent')
                                    .setLabel('What continent are you from?')
                                    .setPlaceholder('North America, Europe, Asia, etc...')
                                    .setStyle(Discord.TextInputStyle.Short)
                                    .setMaxLength(15)
                                    .setRequired(true)),
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-age-check')
                                    .setLabel('Are you 16 years old or older?')
                                    .setPlaceholder('Yes or No. You must be 16+ to join.')
                                    .setStyle(Discord.TextInputStyle.Short)
                                    .setMaxLength(3)
                                    .setRequired(true)));

                    await interaction.showModal(modal);
                }
            },
            'onboarding-modal': {
                async execute(interaction) {
                    if (!interaction.isModalSubmit()) {
                        throw new Error(`Onboarding Submission: expected modal submission, got ${interaction.componentType}`);
                    }

                    // Validate user is an applicant
                    if (!interaction.member || !(interaction.member instanceof Discord.GuildMember)) {
                        // Should never happen...
                        throw new Error(`No reference to applicant who submitted onboarding form.`);
                    }

                    const applicant = interaction.member;
                    if (!applicant.roles.cache.hasAll(...Config.ranks[0].required)) {
                        await interaction.reply({
                            content: `:x: Only applicants can fill out an application form.`,
                            ephemeral: true
                        });
                        return;
                    }

                    // Make sure user doesn't have a pending application
                    let thread = await getApplicantThread(applicant);
                    if (thread && 
                        (thread.appliedTags.includes(Config.onboarding.tags.pending) ||
                        thread.appliedTags.includes(Config.onboarding.tags.flagged))) {
                        await interaction.reply({
                            content: `:x: You already have a pending application open. ` +
                                `Feel free to reach out to us if you have any questions or concerns.`,
                            ephemeral: true,
                        });
                        return;
                    }

                    // 1. Process inputs
                    const platform = interaction.fields.getTextInputValue('onboarding-platform');
                    const name = interaction.fields.getTextInputValue('onboarding-in-game-name');
                    const hasMic = interaction.fields.getTextInputValue('onboarding-microphone');
                    const continent = interaction.fields.getTextInputValue('onboarding-continent');
                    const ageCheck = interaction.fields.getTextInputValue('onboarding-age-check');

                    const embed = new Discord.EmbedBuilder()
                        .setColor(0x3b4d33)
                        .setTitle(`Regiment Join Request`)
                        .setAuthor({name: applicant.displayName, iconURL: applicant.displayAvatarURL()})
                        .setDescription(`Please review this new player's request to join the regiment.`)
                        .addFields(
                            {name: 'Account', value: `<@${applicant.id}>`},
                            {name: 'Platform', value: platform},
                            {name: 'In-Game Name', value: name},
                            {name: 'Has Microphone?', value: hasMic},
                            {name: 'Continent', value: continent},
                            {name: 'Stated they are 16+?', value: ageCheck},
                            {name: 'Application Status', value: 'Not Processed Yet'},
                            {name: 'Reason', value: 'N/A'}
                        ).setTimestamp()
                        .setFooter({text: `Review the information and click Approve, or Reject.`});

                    if (Config.thumbnail_icon_url) embed.setThumbnail(Config.thumbnail_icon_url);

                    // 2. Get thread and post, or post a new thread.
                    if (!thread) {
                        // New thread
                        const onboardingChannel = await getApplicationForum();
                        thread = await onboardingChannel.threads.create({
                            name: `[${applicant.id}] ${applicant.displayName}`,
                            autoArchiveDuration: Discord.ThreadAutoArchiveDuration.OneWeek,
                            message: {
                                embeds: [embed],
                                components: [onboardingButtonRow]
                            }
                        });
                        await setThreadTag(thread, "pending");
                    } else {
                        // Post to existing
                        await setThreadTag(thread, "pending");
                        thread.setName(`[${applicant.id}] ${applicant.displayName}`);
                        thread.send({
                            embeds: [embed],
                            components: [onboardingButtonRow],
                        });
                    }

                    OnboardingLogger.logCreation(applicant, platform, name, hasMic, continent, ageCheck);
                    await interaction.reply({content: `:white_check_mark: Your application was received and is under review!`, ephemeral: true});
                }
            },
            'onboarding-applicant-approve': {
                async execute(interaction) {
                    await interaction.deferUpdate();

                    // 0. Permission checks
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    approveApplicant(interaction, '0');
                },
            },
            'onboarding-applicant-envoy': {
                async execute(interaction) {
                    await interaction.deferUpdate();

                    // 0. Permission checks
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    approveApplicant(interaction, 'E');
                }
            },
            'onboarding-applicant-reject': {
                async execute(interaction) {
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        await interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    const guild = await getGuild();
                    if (!guild) {
                        throw new Error(`Guild not found!`);
                    }

                    const userMention = interaction.message.embeds[0].fields.find(f => f.name === 'Account')?.value || '';
                    const userId = (userMention.match(/<@([0-9]+)>/) || [])[1];
                    let applicant: Discord.GuildMember;

                    try {
                        applicant = await guild.members.fetch(userId);
                    } catch (e) {
                        await interaction.reply({
                            content: `Could not find applicant to reject, did they leave the server?`,
                            ephemeral: true
                        });
                        return;
                    }

                    // Ensure applicant wasn't already approved/rejected.
                    if (!applicant.roles.cache.hasAny(...Config.ranks['0'].required)) {
                        await interaction.reply({
                            content: `Applicant does not have the role(s) new recruits have, maybe they were already approved or rejected?\n\n` +
                                `You can delete this application with the "Delete Application" button.`,
                            ephemeral: true,
                        });
                        return;
                    }

                    // get reason from modal
                    const modal = new Discord.ModalBuilder()
                        .setCustomId('onboarding-rejection-modal')
                        .setTitle('Reject Applicant')
                        .addComponents(
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-rejection-reason')
                                    .setLabel('Reason (shared with applicant)')
                                    .setStyle(Discord.TextInputStyle.Paragraph)
                                    .setMaxLength(400)
                                    .setRequired(true)));

                    rejectionTable[interaction.user.id] = [applicant.id, interaction.message.id];

                    await interaction.showModal(modal);
                },
            },
            'onboarding-rejection-modal': {
                async execute(interaction) {
                    if (!interaction.isModalSubmit()) {
                        throw new Error(`Onboarding Rejection Submission: expected modal submission, got ${interaction.componentType}`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        await interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    await interaction.deferReply();

                    const guild = await getGuild();
                    if (!guild) {
                        throw new Error(`Guild not found!`);
                    }

                    // DM reason, link to nexus and kick
                    let applicant: Discord.GuildMember;
                    const rejectionRecord = rejectionTable[interaction.user.id];

                    try {
                        applicant = await guild.members.fetch(rejectionRecord[0]);
                    } catch (e) {
                        await interaction.followUp({
                            content: `Could not find applicant to reject, did they leave the server?`
                        });
                        return;
                    }
                    const reason = interaction.fields.getTextInputValue('onboarding-rejection-reason') || 'No reason provided';

                    try {
                        await applicant.send({
                            content: `Your application to the 1st Colonial Regiment was rejected for the following reasons:\n\n` +
                                `> ${reason}\n\n` +
                                `If your looking for others to play with, consider checking out the liberty nexus instead: https://discord.gg/EHdedDkzyu.\n\n` +
                                `*I am a bot and i do not respond to messages.*`
                        });
                    } catch (e) {
                        // User has DMs blocked, cannot notify them.
                        await interaction.followUp(`Applicant has DMs blocked, unable to notify them of their rejection and reason.`);
                    }

                    if (interaction.channel) {
                        const applicationMessage = await interaction.channel.messages.fetch(rejectionRecord[1]);

                        const appEmbed = applicationMessage.embeds[0];
                        let field = appEmbed.fields.find(f => f.name === 'Application Status');
                        if (field) {
                            field.value = `Rejected by <@${interaction.user.id}>`;
                        }

                        field = appEmbed.fields.find(f => f.name === 'Reason');
                        if (field) {
                            field.value = reason.slice(0, 1024);
                        }

                        // Update embed, post new message if needed
                        applicationMessage.edit({
                            embeds: [appEmbed],
                            components: []
                        });
                    } else {
                        await interaction.followUp(`Unable to edit application for <@${applicant.id}> (${applicant.displayName}), message not found.`);
                    }

                    if (applicant.kickable) {
                        if (process.env.DEV_MODE) {
                            await interaction.followUp(`Rejected applicant <@${applicant.id}> would be kicked, but development mode is enabled which disables this feature.`);
                        } else {
                            await applicant.kick(`Application rejected by ${interaction.user.displayName}, reason: ${reason}`);
                            await interaction.followUp(`Application rejected, applicant kicked.`);
                        }
                    } else {
                        await interaction.followUp(`Attempted to kick rejected applicant <@${applicant.id}>, but could not. Please manually remove them from the server.`);
                    }

                    if (interaction.channel?.isThread()) {
                        await setThreadTag(interaction.channel as Discord.ForumThreadChannel, "rejected");
                    }
                    OnboardingLogger.logRejection(applicant, interaction.member as Discord.GuildMember, reason);
                },
            },
            'onboarding-applicant-flag': {
                async execute(interaction) {
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        await interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    // get reason from modal
                    const modal = new Discord.ModalBuilder()
                        .setCustomId('onboarding-flag-modal')
                        .setTitle('Flag Applicant')
                        .addComponents(
                            new Discord.ActionRowBuilder<Discord.ModalActionRowComponentBuilder>().addComponents(
                                new Discord.TextInputBuilder()
                                    .setCustomId('onboarding-flag-reason')
                                    .setLabel('Reason for the flag')
                                    .setStyle(Discord.TextInputStyle.Paragraph)
                                    .setMaxLength(500)
                                    .setRequired(true)));

                    flagTable[interaction.user.id] = interaction.message.id;

                    await interaction.showModal(modal);
                },
            },
            'onboarding-flag-modal': {
                async execute(interaction) {
                    if (!interaction.isModalSubmit()) {
                        throw new Error(`Onboarding Rejection Submission: expected modal submission, got ${interaction.componentType}`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        await interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    await interaction.deferReply({ephemeral: true});
                    const embedMessageId = flagTable[interaction.user.id];
                    const reason = interaction.fields.getTextInputValue('onboarding-flag-reason') || 'No reason provided';

                    if (interaction.channel) {
                        const applicationMessage = await interaction.channel.messages.fetch(embedMessageId);

                        const appEmbed = applicationMessage.embeds[0];
                        let field = appEmbed.fields.find(f => f.name === 'Application Status');
                        if (field) {
                            field.value = `Flagged by <@${interaction.user.id}>`;
                        }

                        field = appEmbed.fields.find(f => f.name === 'Reason');
                        if (field) {
                            field.value = reason.slice(0, 1024);
                        }

                        field = appEmbed.fields.find(f => f.name === 'Account');
                        let applicantId = '';
                        if (field) {
                            const match = /<@([0-9]+)>/.exec(field.value)
                            if (match) {
                                applicantId = match[1];
                            } else {
                                throw new Error(`Malformed application when setting flag.`);
                            }
                        }

                        const button = new Discord.ActionRowBuilder<Discord.ButtonBuilder>()
                            .addComponents(
                                new Discord.ButtonBuilder()
                                    .setCustomId('onboarding-flag-clear')
                                    .setLabel('Remove Flag')
                                    .setStyle(Discord.ButtonStyle.Primary));

                        // Update embed, post new message if needed
                        applicationMessage.edit({
                            embeds: [appEmbed],
                            components: [button]
                        });

                        if (interaction.channel.isThread()) {
                            await setThreadTag(interaction.channel as Discord.ForumThreadChannel, "flagged");
                        }
                        OnboardingLogger.logFlag(applicantId, interaction.member as Discord.GuildMember, reason);
                        await interaction.followUp(`:white_check_mark: Application flagged.`);
                    } else {
                        await interaction.followUp(`Unable to flag application, message not found.`);
                    }
                },
            },
            'onboarding-flag-clear': {
                async execute(interaction) {
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        await interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    const appEmbed = interaction.message.embeds[0];
                    const userMention = interaction.message.embeds[0].fields.find(f => f.name === 'Account')?.value || '';
                    const userId = (userMention.match(/<@([0-9]+)>/) || [])[1];

                    let field = appEmbed.fields.find(f => f.name === 'Application Status');
                    if (field) {
                        field.value = `Not Processed Yet`;
                    }

                    field = appEmbed.fields.find(f => f.name === 'Reason');
                    let reason = "";
                    if (field) {
                        reason = field.value;
                        field.value = 'N/A';
                    }

                    interaction.message.edit({
                        embeds: [appEmbed],
                        components: [onboardingButtonRow]
                    });

                    if (interaction.channel?.isThread()) {
                        await setThreadTag(interaction.channel as Discord.ForumThreadChannel, "pending");
                    }
                    OnboardingLogger.logFlagCleared(userId, interaction.member as Discord.GuildMember);
                    await interaction.reply({content: `<@${interaction.user.id}> cleared the flag on <@${userId}>'s application.\nThe flag reason was:\n> ${reason}`});
                },
            },
            'onboarding-applicant-close': {
                async execute(interaction) {
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    await interaction.deferReply({ephemeral: true});

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        await interaction.followUp({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    const appEmbed = interaction.message.embeds[0];
                    const userMention = interaction.message.embeds[0].fields.find(f => f.name === 'Account')?.value || '';
                    const userId = (userMention.match(/<@([0-9]+)>/) || [])[1];

                    // Close the application
                    if (interaction.channel?.isThread()) {
                        await setThreadTag(interaction.channel as Discord.ForumThreadChannel, "closed");
                    }
                    OnboardingLogger.logClose(userId, interaction.member as Discord.GuildMember);
                    await interaction.followUp({content: `:white_check_mark: Application Closed. ` +
                        `The applicant was NOT notified of this or kicked. **Please make sure to tell them what to do next.**`,
                        ephemeral: true
                    });
                }
            },
            'onboarding-problems-addressed': {
                async execute(interaction) {
                    if (!interaction.isButton()) {
                        throw new Error(`Onboarding: expected button, got ${interaction.isModalSubmit() ?
                            'Modal Submission' : interaction.componentType}.`);
                    }

                    if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                        await interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                        return;
                    }

                    // Delete the message
                    await interaction.message.delete();
                    await interaction.reply({content: `:white_check_mark: Problem Report Deleted.`, ephemeral: true});
                },
            }
        }
    },
    'get-application-logs': {
        data: new Discord.SlashCommandBuilder()
            .setName('get-application-logs')
            .setDescription('Get logs for past applications to join.')
            .addStringOption(o =>
                o.setName('file')
                    .setDescription('Logs names are the user ID of the applicant.')
                    .setRequired(true)
                    .setAutocomplete(true))
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.ManageNicknames),
        async execute(interaction) {
            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                await interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                return;
            }

            const file = interaction.options.getString('file') || '';
            const validFiles = OnboardingLogger.getValidFileNames();
            if (!validFiles.includes(file)) {
                await interaction.reply({content: `:x: invalid file name "${file}"`, ephemeral: true});
                return;
            }

            if (!interaction.channel || !interaction.channel.isSendable()) {
                await interaction.reply({content: ':x: You must use this command in a text channel.', ephemeral: true});
                return;
            }

            // send file
            await interaction.reply({
                content: `Application log file attached.`,
                files: [{
                    attachment: OnboardingLogger.getFullLogFilePath(file),
                    name: `${file}`
                }],
                ephemeral: true
            });
        },
        async autocomplete(interaction) {
            if (!roleBasedPermissionCheck('iron', interaction.member as Discord.GuildMember)) {
                // Those who do not have permission do not see the options.
                await interaction.respond([]);
                return;
            }

            const focusedOption = interaction.options.getFocused(true);

            const options = OnboardingLogger.getValidFileNames()
                .filter(f => f.startsWith(focusedOption.value))
                .map(v => {
                    return {name: v, value: v};
                });

            await interaction.respond(options.slice(0, 24));
        }
    },
    'welcome': {
        data: new Discord.SlashCommandBuilder()
            .setName('welcome')
            .setDescription('Posts the welcome and introductory message shown to new members.')
            .addStringOption(o =>
                o.setName('members')
                    .setDescription('The mention(s) (@s) new member(s) to mention in the message.')
                    .setRequired(true))
            .setDefaultMemberPermissions(Discord.PermissionFlagsBits.ManageNicknames),
        async execute(interaction) {
            if (!roleBasedPermissionCheck('onboard', interaction.member as Discord.GuildMember)) {
                await interaction.reply({content: `:x: Access Denied. Requires Freedom Captain permissions.`, ephemeral: true});
                return;
            }

            const input = interaction.options.getString('members', true);
            const matches = [...(input || '').matchAll(/<@([0-9]+)>/g)].map(v => v[1]);
            if (!input || !matches || !matches.length) {
                await interaction.reply({content: `:x: No members provided.`, ephemeral: true});
                return;
            }

            await interaction.reply({
                content: `Welcome ${matches.map(id => `<@${id}>`).join(', ')} to the 1st Colonial Regiment!\n\n` +
                    `You can find an overview of how things work in <#1228740800565743646>. ` +
                    `We host MODs multiple times a week, you can find the schedule for the next one(s) in <#1300502782918266932>. ` +
                    `Play in MODs to earn IRON (the number next to your name), you can earn 1 IRON per week from playing in MODs.\n\n` +
                    `You are also welcomed and encouraged to dive with others whenever you like. You can ping the ON CALL role in <#1289960010801221692>. ` +
                    `If you want that role yourself, get it from <#1244035446439280711>.\n\n` +
                    `If you have any questions, feel free to open a ticket here <#1302076162935230563> if you need to speak with the command team. ` +
                    `Alternatively, you can ask in <#1227465911062233118> for simple questions that anyone can answer.`
            });
        }
    }
};

module.exports = commands;
