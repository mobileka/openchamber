This app is a fork of OpenChamber that diverted from the upstream a little bit too much, so I decided to detach it and keep customizing it for my needs.

That said, I genuinely believe that some of my ideas may be useful to others as well, so I document the differences in this file.

# Dictionary

- Upstream–the original OpenChamber

# Why?

I use OpenCode on 4 different machines. All of them are MacBooks with vastly different specs: a retro mid 2014 MacBook Pro, M1 PRO 16GB, M4 Air 16GB and M4 PRO 64GB.

As I use all of them to some degree, my focus is on being able to maintain consistent user experience (e.g. sharing shorcuts) but also leaving some space for machine-specific features.

For example, my M4 PRO has 64GB of RAM, so it's enough to comfortably run some pretty capable local models (e.g. QWEN3.8-27B) but my other MacBooks don't have this privilage. So I wanted to ensure that my local setup would allow me to set a good shared baseline between the machines but also utilize some specific features and advantages of each individual machine.

OpenChamber is only one of the components of the setup I created for this, and if you have a similar use case, you might find my fork useful.

In addition to that, I added some neat features and fixed a couple of bugs (some got merged into the Upstream), so read on if you're interested in using it.

_Please note I'm not claiming this is the best way to achieve this. I just like hacking things and have lots of product + software engineering experience, so I'm partially doing this for the fun of the game._

# What is different in my fork

## Limitations

I regularly merge Upstream changes into my fork to ensure that it has the latest and greatest improvements folks from OpenChamber introduce to their tool. That said, there are some limitations you should be aware of:

- First, I don't promise that I will keep supporting and adding features to this fork.
- I use it only on MacOS and Android, so I disabled all CI workflows but those that I need (core functionality, Web, MacOS and Android).

This means that my fork is not guaranteed to work on platforms like Linux, Windows or iOS but I suspect that it actually will, so worth trying if you really like the features described below.

## Shortcuts

Upstream keeps shortcut overrides in `preferences.json`. This fork, on the other hand, keeps them in `keybindings.json` next to `settings.json`, so you can sync it between your machines without risking sensitive data.

Additionally, the "Shorcuts" page in the settings has the following improvements:

1. A fuzzy search bar, so you can search through the shortcuts. You can also find a specific shortcut by the key binding (JetBrains style).
2. I fixed a bug where Mac's CMD was recorded as CTRL.
3. I added new shortucts (e.g. you can now toggle the effort level using a shortcut)

[!!! Insert a screenshot]

## Updates

The fork has it's own sophisticated update functionality.

As opposed to just downloading it from the Upstream's releases, it has the following update pathways:

1. Download a release from the fork's GitHub
2. Update to a local build

I also periodically merge the changes from the upstream, so my fork takes advantage of the latest advancements of the Upstream.

The update dialog includes the info on both fork changes and what's new in the upstream.

Additionally, I added a manual "Check for updates" menu item and the "About" page shows the exact version you're running, so it's easy to distinguish from the original app.

## Model list updates

If you have a third-party subscription (e.g. Command Code) where you have to configure the list of models manually, I introduced a background job that updates the list of models, allows you to see what's new and shows you the costs.

## Restart

If you want to restart OpenChamber, you can now use `/restart`. It's also possible to trigger this command from your phone, which would restart OpenChamber and report back when it's back.

This is useful if, for example, you want to use a new model or setting OpenCode/OpenChamber doesn't pick-up without a restart, and you're aware from your machine.

## Scheduled task loops

I found the original logic behind the scheduled tasks (or so called "loops") confusing because they're tied to a specific project.

Instead, I made them "global" but divided into two categories: shared and local.

Local tasks live in `~/.agents/loops`. In this directory you can configure stuff that would only run on one of your machines but can't on others (e.g. one of your machines has enough memory to run a local model and others don't).

The shared tasks can be run on all of your machines and they go in `$OPENCODE_CONFIG_DIR/.agents/loops/*.md`. These jobs can run on all your machines and can easily by synched using something like git. For example, updating the model list belongs to this directory.
