var dev = false;
if (process.env.NODE_ENV == "dev") {
    // DEV MODE ON
    var dev = true;
}

/**
 * IMPORT PACKAGES ----------------------------------------------------------------------------------------------------
 */

// configuration and package file
const config = require("./config.json");
const pkg = require('./package.json');

// imports and creates a discord client
const Discord = require("discord.js");
const client = new Discord.Client();

// sets up webshot to get image of schedule
// options are used to set the size of the image
const webshot = require("webshot");
const webshotOptions = {
    screenSize: {width: 1, height: 1},
    shotSize: {width: "all", height: "all"}, 
    defaultWhiteBackground: true
};

// date formatter
const dateFormat = require("dateformat");

// fs to delete images after they are sent
const fs = require("fs");

// humanize duration to display uptime
const humanizeDuration = require('humanize-duration');
const format = humanizeDuration.humanizer({
	conjunction: ' and ',
	serialComma: true,
	round: true
});

// used in parsing and using crontabs
const cronParser = require("cron-parser");
const schedule = require("node-schedule");
const prettyCron = require("prettycron");

/**
 * DATABASE FETCH ----------------------------------------------------------------------------------------------------
 */

// import and create a mysql connection pool
const mysql = require("mysql");
// use config file for configuration
const mysqlConfig = require("./mysql-config.json");
const pool = mysql.createPool(mysqlConfig);

// this array stores serverconfig
// it is keyed by server id
var serverconfig = [];

// this array stores autoschedule definitions
// it is keyed by channel id
var autoschedules = [];

// this array stores autoschedule jobs
// it is keyed by job id, found in autoschedules
var jobs = [];

// GRAB SERVER CONFIG FROM THE DATABASE
pool.query("SELECT serverid,prefix,display_type FROM servers", (err, results, fields) => {
    if (err) throw err;
    // loop through results, adding them to the servers array
    for (i = 0; i < results.length; i++) {
		serverconfig[results[i].serverid] = {
	        prefix: results[i].prefix,
	        display_type: results[i].display_type
		};
	}
	console.log(serverconfig);
	console.log("Loaded " + results.length + " servers");
});

// GRAB AUTOSCHEDULES FROM THE DATABASE
pool.query("SELECT * FROM autoschedules", (err, results, fields) => {
    if (err) throw err;
    // loop through results
    for (j = 0; j < results.length; j++) {
        // get our values
        var channel = results[j].channel_id;
        var selector = results[j].selector;
        var type = results[j].type;
        var cron = results[j].cron;
        var deleteOld = results[j].delete_old.lastIndexOf(1) !== -1;
        var lastID = results[j].last_id;
        // save the autoschedule definition for easy access
        // this is for autoschedule show command
        autoschedules[channel] = {
            selector: selector,
		    type: type, 
		    cron: cron, 
		    deleteOld: deleteOld,
		    lastID: lastID,
		    jobID: j
		};
        // schedule a job, binding the channel id
        jobs[j] = schedule.scheduleJob(cron, function () {
		    executeAutoSchedule(this.channel);
		}.bind({channel: channel}));
	}
	console.log(autoschedules);
	console.log("Loaded " + results.length + " autoschedules");
});

/**
 * GUILD OPERATIONS ----------------------------------------------------------------------------------------------------
 */
 
// this function saves a guild, given a guild object, a valid <=32 character prefix, and a display type
const saveGuildQuery = "INSERT INTO servers (serverid, prefix, display_type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE serverid = VALUES (serverid), prefix = VALUES (prefix), display_type = VALUES (display_type);";
function saveGuild(guild, prefix, displayType) {
	pool.query(saveGuildQuery, [guild.id, prefix, displayType], (err, results, fields) => {
	    if (err) console.log(err);
	    if (dev) console.log("Guild " + guild.id + " saved with prefix " + prefix + " and display type " + displayType);
	});
}

// this function deletes a guild, given a guild object
const delGuildQuery = "DELETE FROM servers WHERE serverid = ?";
function delGuild(guild) {
	pool.query(delGuildQuery, [guild.id], (err, results, fields) => {
	    if (err) console.log(err);
	    if (dev) console.log("Guild " + guild.id + " deleted");
	});
}

// this function sets a configuration field for a guild, given a channel, field, and value
const setConfigQuery = "UPDATE servers SET ??=? WHERE serverid=?";
function setConfig(channel, fieldInput, valueInput) {
    var field;
    var value;
    switch (fieldInput) {
        case "prefix":
            field = "prefix";
            value = valueInput.substring(0, 32);
            break;
        case "displaytype":
            field = "display_type";
            if (["image", "text"].indexOf(valueInput) > -1) {
                value = valueInput;
            } else {
                channel.send("Invalid display type!");
                return;
            }
            break;
    }
    serverconfig[channel.guild.id][field] = value;
    pool.query(setConfigQuery, [field, value, channel.guild.id], (err, results, fields) => {
        if (err) console.log(err);
        if (dev) console.log("Saved guild " + field + " as " + value);
    })
    channel.send("Set '" + fieldInput + "' for this guild to '" + valueInput + "'");
}

// this function gets a configuration field for a guild, given a channel and field
function getConfig(channel, fieldInput) {
    var field;
    switch (fieldInput) {
        case "prefix":
            field = "prefix";
            break;
        case "displaytype":
            field = "display_type";
            break;
    }
    channel.send("'" + fieldInput + "' for this guild is set to '" + serverconfig[channel.guild.id][field] + "'");
}


/**
 * EMERGENCY SENDING ----------------------------------------------------------------------------------------------------
 */

function sendEmergency(channel) {
    // this command takes a while to run, so start typing
    channel.startTyping();
    // create filename
    var timestamp = dateFormat(Date.now(), "yyyymmddHHMMss");
    var filename = "./images/emergency_" + channel.id + "_" + timestamp + ".png";
    // webshot
    webshot("https://schedules.sites.tjhsst.edu/emergency/", filename, webshotOptions, (err) => {
        // send it
        channel.send(new Discord.Attachment(fs.createReadStream(filename), "emergency.png"))
            .then(message => {
                // delete the image
                fs.unlink(filename, (err) => {});
                if (dev) console.log("Sent emergency to channel " + channel.id);
            });
        channel.stopTyping();
    });
}

/**
 * SCHEDULE SENDING ----------------------------------------------------------------------------------------------------
 */

// this function sends a schedule to a channel, given a type and a date
const selectorOffset = {
    "last": -1, 
    "this": 0,
    "next": 1
}
function sendSchedule(channel, selectorInput, typeInput, dateInput, autoscheduleSaveID=false) {
    // this command takes a while to run, so start typing
    channel.startTyping();
    // set date using offset
    var date = new Date(dateInput);
    var offset = selectorOffset[selectorInput];
    switch (typeInput) {
        case "day":
            date.setDate(date.getDate() + offset);
            break;
        case "week":
            date.setDate(date.getDate() + (offset * 7));
            break;
        case "month":
            date.setMonth(date.getMonth() + offset);
            break;
    }
    // create filename
    var timestamp = dateFormat(Date.now(), "yyyymmddHHMMss");
    var filename = "./images/schedule_" + channel.id + "_" + timestamp + ".png";
    // create request argument string
    var requestArgs = "type=" + typeInput + "&date=" + dateFormat(date, "UTC:yyyy-mm-dd");
    // build url
    var url = "https://schedules.sites.tjhsst.edu/schedule/?" + requestArgs;
    // webshot
    webshot(url, filename, webshotOptions, (err) => {
        // send it
        channel.send(new Discord.Attachment(fs.createReadStream(filename), "schedule.png"))
            .then(message => {
                // delete the image
                //fs.unlink(filename, (err) => {});
                // save id if needed
                if (autoscheduleSaveID) {
                    saveID(channel, message);
                }
                if (dev) console.log("Sent " + selectorInput + " " + typeInput + " schedule to channel " + channel.id);
            });
        channel.stopTyping();
    });
}

/**
 * AUTOSCHEDULE OPERATIONS ----------------------------------------------------------------------------------------------------
 */

// this function deletes an autoschedule job from the job array, given a job ID
function deleteAutoScheduleJob(jobID) {
    // check if it exists
    if (jobs[jobID] !== undefined) {
        // stop it
        jobs[jobID].cancel();
        // delete it
        delete jobs[jobID];
        if (dev) console.log("Deleted autoschedule job " + jobID);
    }
}

// this function sets an autoschedule, given a channel object, a type, and a cron
const setAutoQuery = "INSERT INTO autoschedules (channel_id, selector, type, cron, delete_old) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES (channel_id), selector = VALUES (selector), type = VALUES (type), cron = VALUES (cron), delete_old = VALUES (delete_old);";
function setAutoSchedule(channel, selectorInput, typeInput, cronInput, deleteOld) {
    if (autoschedules[channel.id] !== undefined) {
        // if already exists
        var jobID = autoschedules[channel.id].jobID;
        // delete job
        deleteAutoScheduleJob(jobID);	
        // update the definition, retaining jobID and lastID
        var lastID = autoschedules[channel.id].lastID;
        autoschedules[channel.id] = {
            selector: selectorInput,
		    type: typeInput, 
		    cron: cronInput, 
		    deleteOld: deleteOld,
		    lastID: lastID,
		    jobID: jobID
		};
    } else {
        // doesn't exist, create new definition
        autoschedules[channel.id] = {
            selector: selectorInput,
		    type: typeInput, 
		    cron: cronInput, 
		    deleteOld: deleteOld,
		    lastID: null,
		    jobID: jobs.length
		};
    }
    // create new job
    jobs[autoschedules[channel.id].jobID] = schedule.scheduleJob(cronInput, function () {
	    executeAutoSchedule(this.channel);
	}.bind({channel: channel.id}));
	// save the autoschdule to database
    pool.query(setAutoQuery, [channel.id, selectorInput, typeInput, cronInput, deleteOld], (err, results, fields) => {
        if (err) console.log(err);
        // get pretty string from cron
	    var prettyString = prettyCron.toString(cronInput);
	    // give feedback to channel
        channel.send("Set autoschedule to send " + selectorInput + " " + typeInput + " schedule " + prettyString.charAt(0).toLowerCase() + prettyString.substring(1) + ((deleteOld) ? ", deleting old schedules" : ""));
        if (dev) console.log("Set autoschedule in channel " + channel.id);
	});
}

// this function shows an autoschedule, given a channel object
const showAutoQuery = "SELECT * FROM autoschedules WHERE channel_id = ?";
function showAutoSchedule(channel, typeInput) {
	if (autoschedules[channel.id] === undefined) {
	    // if doesn't exist
	    // send a message
        channel.send("This channel does not have an autoschedule");
    } else {
        // does exist
        // get selector
        var selector = autoschedules[channel.id].selector;
        // get type 
        var type = autoschedules[channel.id].type;
        // get cron
        var cron = autoschedules[channel.id].cron;
        // get delete old
        var deleteOld = autoschedules[channel.id].deleteOld;
        switch (typeInput) {
            case "definition":
                // get pretty string from cron
                var prettyString = prettyCron.toString(cron);
                // send to channel
                channel.send("Autoschedule is set to send " + selector + " " + type + " schedule " + prettyString.charAt(0).toLowerCase() + prettyString.substring(1) + ((deleteOld) ? ", deleting old schedules" : ""));
                break;
            case "command":
                // get prefix
                var prefix = prefixes[channel.guild.id];
                // send to channel
                channel.send("The command to set this channel's autoschedule is: ```" + prefix + "autoschedule set " + selector + " " + type + " " + cron + " " + ((deleteOld) ? " delete-old" : "") + "```");
                break;
            case "next":
                // get next
                var nextExec = prettyCron.getNext(cron);
                // send to channel
                channel.send("Autoschedule will fire " + nextExec.charAt(0).toLowerCase() + nextExec.substring(1));
        }
        if (dev) console.log("Showed autoschedule " + typeInput + " in channel " + channel.id);
    }
}

// this function deletes an autoschedule, given a channel object
const delAutoQuery = "DELETE FROM autoschedules WHERE channel_id = ?";
function deleteAutoSchedule(channel) {
    if (autoschedules[channel.id] !== undefined) {
        // if already exists
        // delete job
        deleteAutoScheduleJob(autoschedules[channel.id].jobID);	
        // delete definition
        delete autoschedules[channel.id];
        // delete from database
        pool.query(delAutoQuery, [channel.id], (err, results, fields) => {
            if (err) console.log(err);
	        // give feedback to channel
	        channel.send("Deleted autoschedule for this channel");
	        if (dev) console.log("Deleted autoschedule from channel " + channel.id);
    	});
    } else {
        // nothing to delete
        // give feedback to channel
        channel.send("This channel does not have an autoschedule");
    }
}

// this is a callback for autoscheudules
// this function executes an autoschedule given a channelid
function executeAutoSchedule(channelid) {
    // get a channel object
    const channel = client.channels.get(channelid);
    if (channel === undefined) {
        // if we don't have access to this channel
        // delete the job that called this function
        deleteAutoScheduleJob(autoschedules[channelid].jobID);
        // delete the autoschedule from the database
        pool.query(delAutoQuery, [channelid], (err, results, fields) => {
            if (err) console.log(err);
            if (dev) console.log("Tried to execute autoschedule in channel " + channelid + ", but channel not found. Deleted autoschedule.");
        });
    } else {
        // we have the channel
        // get selector
        const selector = autoschedules[channelid].selector;
        // get type
        const type = autoschedules[channelid].type;
        // delete if we need to
        if (autoschedules[channelid].deleteOld && autoschedules[channelid].lastID !== null) {
            channel.fetchMessage(autoschedules[channelid].lastID)
                .then(message => {
                    message.delete()
                        .then(() => {
                            // send the schedule
                            sendSchedule(channel, selector, type, dateFormat(new Date(), "yyyy-mm-dd"), true);
                        });
                })
                .catch(e => {
                    // if the message has already been deleted
                    if (e.code !== 10008) {
                        throw e;
                    }
                    // send the schedule
                    sendSchedule(channel, selector, type, dateFormat(new Date(), "yyyy-mm-dd"), true);
                });
        } else {
            // send the schedule
            sendSchedule(channel, selector, type, dateFormat(new Date(), "yyyy-mm-dd"), true);
        }
        if (dev) console.log("Autoschedule fired in channel " + channelid);
    }
}

// this function saves autoschedule last id
const saveLastQuery = "UPDATE autoschedules SET last_id=? WHERE channel_id=?";
function saveID(channel, message) {
    // save the last id
    autoschedules[channel.id].lastID = message.id;
    // save the last id to database
    pool.query(saveLastQuery, [message.id, channel.id], (err, results, fields) => {
        if (err) console.log(err);
    })
}
/**
 * DISCORD CLIENT ----------------------------------------------------------------------------------------------------
 */

// set prefix when guild is added
client.on('guildCreate', guild => {
	prefixes[guild.id] = "!";
	saveGuild(guild, "!", "image");
});

// remove prefix when guild is removed
client.on('guildDelete', guild => {
	delete prefixes[guild.id];
	delGuild(guild);
});

/**
 * COMMAND HANDLER --------------------------------------------------
 */
client.on("message", async message => {
    // if there is no prefix, set one
    // this can happen for many reasons, the main reason is if the bot is added while the bot is offline
    if (serverconfig[message.guild.id] == undefined) {
		serverconfig[message.guild.id] = {
		    prefix: "!", 
		    displayType: "image"
		};
		saveGuild(message.guild, "!", "image");
	}
	
	// ignore messages if:
	//  they are from a bot
	//  it does not start with the prefix or mention
	//  it is from a DM channel
    if (message.author.bot || (message.content.indexOf(serverconfig[message.guild.id].prefix) !== 0 && !message.isMentioned(client.user.id)) || message.channel instanceof Discord.DMChannel) return;
    
    // get array of arguments and command
    var args = message.content.toLowerCase().replace(serverconfig[message.guild.id].prefix, "").replace(`<@${client.user.id}>`, "").trim().split(/ +/g);
    var command = args.shift();
    
    /**
     * COMMANDS START -------------------------
     */
    
    // PING command
    if (command === "ping") {
        // send a message
        const m = await message.channel.send("Ping?");
        // edit it with the time it took to send the message and api latency
        m.edit("Pong!\nMessage RTT: `" + (m.createdTimestamp - message.createdTimestamp) + "ms`\nAPI Latency: `" + Math.round(client.ping) + "ms`");
        if (dev) console.log("Executed ping in channel " + message.channel.id + " by " + message.author.id);
        return;
    }
    
    // SCHEDULE command
    if (command === "schedule") {
        
        // get arguments
        var selectorInput;
        var typeInput;
        var dateInput;
        var arg;
        
        // next argument
        arg = args.shift();
        if (["yesterday", "today", "tomorrow"].indexOf(arg) > -1) {
            // if it's a valid keyword, set arguments
            typeInput = "day";
            // date is current date
            dateInput = dateFormat(new Date(), "yyyy-mm-dd");
            switch (arg) {
                case "yesterday":
                    selectorInput = "last";
                    break;
                case "today":
                    selectorInput = "this";
                    break;
                case "tomorrow":
                    selectorInput = "next";
                    break;
            }
        } else {
            // invalid keyword, continue processing
            if (["last", "this", "next"].indexOf(arg) > -1) {
                // if it's a valid selector, set it
                selectorInput = arg;
            } else {
                // invalid type, put the argument back (type is optional)
                args.unshift(arg);
                // selector defaults to this
                selectorInput = "this";
            }
            // next argument
            arg = args.shift();
            if (["day", "week", "month"].indexOf(arg) > -1) {
                // if it's a valid type, set it
                typeInput = arg;
            } else {
                // invalid type, put the argument back (type is optional)
                args.unshift(arg);
                // type defaults to "day"
                typeInput = "day";
            }
            // next argument
            arg = args.shift();
            if (!isNaN(new Date(arg))) {
                // if it's a valid date, set it
                dateInput = arg;
            } else {
                // invalid date, put the argument back (date is optional)
                args.unshift(arg);
                // date defaults to current date
                dateInput = dateFormat(new Date(), "yyyy-mm-dd");
            }
                
        }
        
        // call send schedule
        sendSchedule(message.channel, selectorInput, typeInput, dateInput);
        if (dev) console.log("Executed schedule in channel " + message.channel.id + " by " + message.author.id);
        return;
    }
    
    // AUTOSCHEDULE command
    if (command === "autoschedule") {
		// throw away the command, get the first argument and use that as the autoschedule action
        command = args.shift();
        
        if (command === undefined) {
            // user has called autoschedule with no action
            message.channel.send("Use autoschedule set, show, or delete");
            if (dev) console.log("Executed autoschedule in channel " + message.channel.id + " by " + message.author.id);
            return;
        }
        
        // check for permissions
        // ALL autoschedule commands except show require the MANAGE_GUILD permission
        // unless they're me
        if (!message.member.hasPermission("MANAGE_GUILD") && message.author.id !== "288477253535399937" && command !== "show") {
			message.channel.send("You are not allowed to do that!");
			return;
		}
        
        if (command === "set") {
            // user has called autoschedule set
            
            // get arguments
            var selectorInput;
            var typeInput;
            var cronInput;
            var deleteOld;
            var arg;
            
            // next argument
            arg = args.shift();
            if (["yesterday", "today", "tomorrow"].indexOf(arg) > -1) {
                // if it's a valid keyword, set arguments
                typeInput = "day";
                // date is current date
                dateInput = dateFormat(new Date(), "yyyy-mm-dd");
                switch (arg) {
                    case "yesterday":
                        selectorInput = "last";
                        break;
                    case "today":
                        selectorInput = "this";
                        break;
                    case "tomorrow":
                        selectorInput = "next";
                        break;
                }
            } else {
                // invalid keyword, continue processing
                if (["last", "this", "next"].indexOf(arg) > -1) {
                    // if it's a valid selector, set it
                    selectorInput = arg;
                } else {
                    // invalid selector, put the argument back (selector is optional)
                    args.unshift(arg);
                    // selector defaults to this
                    selectorInput = "this";
                }
                // next argument
                arg = args.shift();
                if (["day", "week", "month"].indexOf(arg) > -1) {
                    // if it's a valid type, set it
                    typeInput = arg;
                } else {
                    // invalid type, stop execution and return
                    message.channel.send("Invalid type!");
                    return;
                }
            }
            
            // cron is five arguments
            // cut it to 32 characters
            // if it's a really long cron it won't fit into the database
            arg = args.splice(0, 5).join(" ").substring(0, 32);
            if (arg.length < 9) {
                // if it's too short to be a cron, it is invalid cron, stop execution and return
                // (for some reason cron parser doesn't catch this as an invalid cron)
                message.channel.send("Invalid cron!");
                return;
            }
            try {
                // run cron through the cronparser
                cronParser.parseExpression(arg);
                // set
                cronInput = arg;
            } catch (e) {
                // the cron failed to parse
                // invalid cron, stop execution and return
                message.channel.send("Invalid cron!");
                return;
            }
            
            // next argument
            arg = args.shift();
            if (arg === "delete-old") {
                deleteOld = true;
            } else {
                deleteOld = false;
            }
            
            // call set autoschedule
            setAutoSchedule(message.channel, selectorInput, typeInput, cronInput, deleteOld);
            if (dev) console.log("Executed autochedule set in channel " + message.channel.id + " by " + message.author.id);
        }
        if (command === "execute") {
            // user has called autoschedule execute
            // call execute autoschedule
            executeAutoSchedule(message.channel.id);
            if (dev) console.log("Executed autoschedule execute in channel " + message.channel.id + " by " + message.author.id);
        }
        if (command === "show") {
            // user has called autoschedule show
            // get arguments
            var typeInput;
            var arg;
            
            // next argument
            arg = args.shift();
            if (["definition", "command", "next"].indexOf(arg) > -1) {
                // if it's a valid type, set it
                typeInput = arg;
            } else {
                // invalid type, put the argument back (type is optional)
                args.unshift(arg);
                // type defaults to definition
                typeInput = "definition";
            }
            // call show autoschedule
            showAutoSchedule(message.channel, typeInput);
            if (dev) console.log("Executed autoschedule show in channel " + message.channel.id + " by " + message.author.id);
        }
        if (command === "delete") {
            // user has called autoschedule delete
            // call delete autoschedule
            deleteAutoSchedule(message.channel);
            if (dev) console.log("Executed autoschedule delete in channel " + message.channel.id + " by " + message.author.id);
        }
        return;
    }
    
    // EMERGENCY command
    if (command === "emergency") {
        // call send emergency
        sendEmergency(message.channel);
    }
    
    // HELP command
    if (command === "help") {
        // get the prefix to display it
        var prefix = serverconfig[message.guild.id].prefix;
        
        // throw away the command, get the first argument and use that as the help command
        command = args.shift();
        
    	var embed = new Discord.RichEmbed()
    	embed.setColor(0x2d31ff)
			.setThumbnail("https://i.imgur.com/FXO2ASN.png");
        
        if (command === undefined) {
            // user has called help with no command
            // build embed
            embed.setTitle("TJHSST Schedule Bot Command List")
                .setDescription("For additional help, use " + prefix + "help *command*, where *command* is the command you need help for.")
    			.addField(prefix + "help [*command*]", "Displays help message\n**command: **command to get help for")
    			.addField(prefix + "ping", "Pings the bot")
    			.addField(prefix + "info", "Displays bot info")
    			.addField(prefix + "serverconfig", "Sets or gets configuration for this guild (requires \"Manage Server\" permission)")
    			.addField(prefix + "schedule", "Gets schedule")
    			.addField(prefix + "autoschedule", "Automatically sends schedules periodically to the current channel (requires \"Manage Server\" permission)\n")
    			.addField(prefix + "emergency", "Gets emergency alerts")
        } else if (command === "serverconfig") {
            // user has called help serverconfig
            embed.setTitle("TJHSST Schedule Bot Command List - Server Config")
                .setDescription("The serverconfig command sets or gets configuration for this guild. It requires the \"Manage Server\" permission.")
                .addField(prefix + "serverconfig set *field* *value*", "Sets configuration for this guild\n**field: **Configuration field\n**value: **Configuration value")
                .addField(prefix + "serverconfig get *field*", "Gets configuration for this guild\n**field: **Configuration field")
                .addField("Configuration Field List", "- prefix\n- displaytype (in development)");
        } else if (command === "schedule") {
            // user has called help schedule
            embed.setTitle("TJHSST Schedule Bot Command List - Schedule")
                .setDescription("The schedule command gets schedules. Schedules can be selected either with a keyword or a selector and type. By default, schedules are generated relative to the current date, but the reference date can be specified if desired.")
                .addField(prefix + "schedule *keyword* [*date*]", "**keyword: **Selects schedule and type (yesterday | today | tomorrow)\n**date: **The date of the schedule (default: current date)")
                .addField(prefix + "schedule [*selector*] [*type*] [*date*]", "**selector: **Selects which schedule (last | this | next, default: this)\n**type: **Type of schedule (day | week | month, default: day)\n**date: **The date of the schedule (default: current date)");
        } else if (command === "autoschedule") {
            // user has called help autoschedule
            embed.setTitle("TJHSST Schedule Bot Command List - Auto Schedule")
                .setDescription("The autoschedule command sets automatic schedules. It requires the \"Manage Server\" permission. Autoschedules are defined using cron syntax. If you are not familiar with cron syntax, then a [Graphical Crontab Editor](http://corntab.com) can be used.")
                .addField(prefix + "autoschedule set *keyword* *cron* [*flags*]", "**keyword: **A keyword accepted by the schedule command\n**cron: **A valid crontab describing when to send the schedule\n**flags: **Extra options, separated by spaces\n- **delete-old: **deletes old schedules")
                .addField(prefix + "autoschedule set [*selector*] *type* *cron* [*flags*]", "**selector: **A selector accepted by the schedule command\n**type: **A schedule type accepted by the schedule command\n**cron: **A valid crontab describing when to send the schedule\n**flags: **Extra options, separated by spaces\n- **delete-old: **deletes old schedules")
                .addField(prefix + "autoschedule execute", "Triggers execution of saved autoschedule, regardless of scheduled execution time")
    			.addField(prefix + "autoschedule show [*type*]", "Shows autoschedule information in the current channel\n**type: **Desired autoschedule information (definition | command | next, default: definition)")
    			.addField(prefix + "autoschedule delete", "Deletes the autoschedule from the current channel")
        } else {
            // user has called help with an invalid command, stop execution and return
            message.channel.send("No additional help available for " + command);
            return;
        }
        embed.addField("Notes", "- Commands do NOT work in DM.\n- Arguments in [square brackets] are optional\n- Do not include brackets when typing commands.");
		// send
		message.channel.send({embed})
		    .catch((e) => {
		        if (e instanceof Discord.DiscordAPIError && e.code == 50013) { 
		            sendMissingPermissionsError(message.channel);
		        } else {
		            throw e;
		        }
		    });
	    if (dev) console.log("Executed help in channel " + message.channel.id + " by " + message.author.id);
	    return;
    }
    
    // INFO command
    if (command === "info") {
        // get all the necessary information to display it
        var prefix = serverconfig[message.guild.id].prefix;
		var guilds = client.guilds.size;
		var uptime = format(process.uptime() * 1000);
		var version = pkg.version;
		// build embed
		var embed = new Discord.RichEmbed()
			.setTitle("TJHSST Schedule Bot")
			.setDescription("This bot serves TJHSST bell schedules\nUse `" + prefix + "help` to view commands\nCode on [GitHub](https://github.com/DarinMao/schedule-bot)\n[Add Schedules Bot to your own server](https://discordapp.com/oauth2/authorize?client_id=491431910795509780&scope=bot&permissions=52224)")
			.setColor(0x2d31ff)
			.setURL("https://darinmao.tk/schedule-bot")
			.setFooter("Ailuropoda Melanoleuca#0068 | Written using discord.js", "https://i.imgur.com/tymDoDZ.jpg")
			.setThumbnail("https://i.imgur.com/FXO2ASN.png")
			.addField("Prefix", prefix, true)
			.addField("Guilds", guilds, true)
			.addField("Version", version, true)
			.addField("Uptime", uptime);
		// send
		message.channel.send({embed})
		    .catch((e) => {
		        if (e instanceof Discord.DiscordAPIError && e.code == 50013) { 
		            sendMissingPermissionsError(message.channel);
		        } else {
		            throw e;
		        }
		    });
	    if (dev) console.log("Executed info in channel " + message.channel.id + " by " + message.author.id);
	    return;
    }
    
    // SERVERCONFIG command
    if (command === "serverconfig") {
        // throw away the command, get the first argument and use that as the serverconfig action
        command = args.shift();
        
        if (command === undefined) {
            // user has called autoschedule with no action
            message.channel.send("Use serverconfig set, get, or show");
            if (dev) console.log("Executed serverconfig in channel " + message.channel.id + " by " + message.author.id);
            return;
        }
        
        // check for permissions
        // setprefix command requires the MANAGE_GUILD permission
        // unless they're me 
        if (!message.member.hasPermission("MANAGE_GUILD") && message.author.id !== "288477253535399937") {
			message.channel.send("You are not allowed to do that!");
			return;
		}
		
		if (command === "set") {
		    // user has called serverconfig set
		    // get arguments
		    var field;
		    var value;
		    var arg;
		    
		    // next argument
            arg = args.shift();
            if (["prefix", "displaytype"].indexOf(arg) > -1) {
                // if it's a valid field, set it
                field = arg;
            } else {
                // invalid field, stop execution and return
                message.channel.send("Invalid field!");
                return;
            }
            
            // next argument
            arg = args.shift();
            if (arg !== undefined) {
                // if there is a value, set it
                value = arg;
            } else {
                // no value, stop execution and return
                message.channel.send("Please specify a value!");
                return;
            }
            
            // call set config
            setConfig(message.channel, field, value);
            if (dev) console.log("Executed serverconfig set in channel " + message.channel.id + " by " + message.author.id);
		}
		
		if (command === "get") {
		    // user has called serverconfig get
		    // get arguments
		    var field;
		    var arg;
		    
		    // next argument
		    arg = args.shift();
		    if (["prefix", "displaytype"].indexOf(arg) > -1) {
		        // if it's a valid field, set it
		        field = arg;
		    } else {
		        // invalid field, stop execution and return
		        message.channel.send("Invalid field!");
		        return;
		    }
		    
		    // call get config
		    getConfig(message.channel, field);
		    if (dev) console.log("Executed serverconfig get in channel " + message.channel.id + " by " + message.author.id);
		}
		
		return;
    }
});

// set server game status when logged in
client.on("ready", () => {
    console.log("Logged in");
    updateStatus();
    setInterval(() => {
	    updateStatus();
	}, 10000);
})

// login to discord
client.login(config.token);

/**
 * MISC OPERATIONS ----------------------------------------------------------------------------------------------------
 */

/**
 * sets the playing status to
 *  guilds
 *  users
 *  help command
 */
var statusIndex = 0;
function updateStatus() {
    if (statusIndex == 0) {
    	var gameString = client.guilds.size + " guild";
    	if (client.guilds.size != 1) gameString += "s";
    	client.user.setActivity(gameString);
    	if (dev) console.log("Changed to guilds status");
    	statusIndex++;
    }
    else if (statusIndex == 1) {
        var gameString = client.users.size + " user";
        if (client.users.size != 1) gameString += "s";
        client.user.setActivity(gameString);
        if (dev) console.log("Changed to users status");
        statusIndex++;
    }
    else if (statusIndex == 2) {
        client.user.setActivity("use !help");
        if (dev) console.log("Changed to help status");
        statusIndex = 0;
    }
}

// this function sends a message when permissions are missing
function sendMissingPermissionsError(channel) {
    var message = "Hey! It looks like you tried to execute a command, but I'm not allowed to respond!\nThis bot is still in development and is updated faster than our track and field team can run. It's possible some new features need different permissions.\nSince you're reading this, I already have permission to read and send messages. I also need permission to **Embed Links** and **Attach Files**.";
    channel.send(message);
    if (dev) console.log("Sent missing permissions message in channel " + channel.id);
}

// hopefully will catch anything I forgot to catch
// make more stable?
// or maybe less stable depending on how you look at it
process.on('unhandledRejection', (e) => {
	console.log(e);
});
