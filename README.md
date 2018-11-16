# schedule-bot
A Discord bot to serve TJHSST schedules

## Add the bot! 
Add the bot with this link: https://discordapp.com/oauth2/authorize?client_id=491431910795509780&scope=bot&permissions=51200

## Features
* Day, week, and month schedules
* Custom date for schedules
* Automatically send a schedule to a channel periodically

## How does it work??????
Whenever it gets a message, the bot determines if it's a valid command. If it is, the bot parses all your arguments and uses my [Schedules API](https://schedules.sites.tjhsst.edu/) to generate images of the schedules before sending them off. Autoschedules use [node-schedule](https://www.npmjs.com/package/node-schedule) to trigger periodically. 

The bot uses a MySQL database to store information about prefixes and autoschedules. 

for more details you could always read the source (and send some PRs because I suck at good code)...
