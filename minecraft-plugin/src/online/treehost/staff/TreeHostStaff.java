package online.treehost.staff;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.Timer;
import java.util.TimerTask;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.bukkit.BanList;
import org.bukkit.Bukkit;
import org.bukkit.ChatColor;
import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.OfflinePlayer;
import org.bukkit.World;
import org.bukkit.entity.Entity;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.inventory.meta.SkullMeta;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.player.AsyncPlayerChatEvent;
import org.bukkit.event.player.AsyncPlayerPreLoginEvent;
import org.bukkit.event.player.PlayerCommandPreprocessEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerKickEvent;
import org.bukkit.event.player.PlayerLoginEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.event.server.ServerCommandEvent;
import org.bukkit.event.server.ServerListPingEvent;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scoreboard.Scoreboard;
import org.bukkit.scoreboard.Team;

import net.md_5.bungee.api.chat.BaseComponent;
import net.md_5.bungee.api.chat.ComponentBuilder;
import net.md_5.bungee.api.chat.HoverEvent;
import net.md_5.bungee.api.chat.TextComponent;

/**
 * Tree Host staff protection. Installed by Tree Host on every Paper / Spigot / Purpur / Folia / CraftBukkit server.
 *
 * Tree Host keeps plugins/TreeHostStaff/staff.txt up to date (one "minecraftName|Role" per line). Staff:
 *  - can always join (whitelist, bans and a full server don't stop them),
 *  - can't be kicked or banned (kick and ban commands on them are refused, bans are undone),
 *  - are announced when they join, in green and gold,
 *  - wear a gold STAFF badge in chat (hover: "Official Tree Host Staff"), above their head and in the player list,
 *  - are made operator while they're on the server when their role may run commands ("#op=name" lines); it's taken
 *    away again when they leave, and an owner's own ops are never touched (granted-ops.txt remembers which ones),
 *  - get /thstaff (a menu: vanish, gamemode, server health, staff chat, players to teleport to, inventories, and
 *    their own settings), /sc (staff chat), /thvanish and /thinfo,
 *  - choose (in Account or the menu) whether they're announced ("#quiet=name" turns it off), whether a STAFF tag
 *    floats over their head that they can see themselves in third person (1.19.4+, "#nobadge=name" turns it off),
 *    and whether they're made operator; changes made in the menu go to prefs-out.txt for Tree Host to save,
 *  - have every command they run written to the console and plugins/TreeHostStaff/staff-actions.log, so the owner
 *    can see what staff did on their server.
 * Only on online-mode servers (or behind a proxy that checks accounts), so a name really belongs to its owner.
 *
 * Creators (YouTubers) are in plugins/TreeHostStaff/creators.txt ("minecraftName|Label|perk,perk"), with the perks
 * Tree Host staff gave their role:
 *  - badge:     a red "▶ YOUTUBER" tag above their head, in chat and in the player list,
 *  - announce:  everyone is told when they join,
 *  - joinfull:  they can join when the server is full,
 *  - whitelist: they can join through the whitelist.
 * Creators get no protection from kicks or bans: those stay the owner's call.
 *
 * Launch fund supporters are in plugins/TreeHostStaff/founders.txt ("minecraftName|tier", tier = supporter, founder or
 * legend). They wear a cosmetic badge in chat, the player list and above their head: ♥ SUPPORTER, ★ FOUNDER, ✦ LEGEND.
 * Staff and creator badges come first.
 */
public final class TreeHostStaff extends JavaPlugin implements Listener {
    private static final String BADGE = ChatColor.GOLD + "" + ChatColor.BOLD + "✔ STAFF " + ChatColor.RESET;
    private static final String PREFIX = ChatColor.GREEN + "" + ChatColor.BOLD + "Tree Host " + ChatColor.GOLD + "» ";
    private static final String TEAM = "th_staff";
    private static final String CREATOR_TEAM = "th_creator";
    private static final Set<String> KICK_BAN_COMMANDS = new HashSet<>(Arrays.asList(
            "kick", "ban", "ban-ip", "banip", "ipban", "tempban", "tempbanip", "tempipban", "mute", "tempmute", "jail",
            "ekick", "eban", "ebanip", "etempban", "kickall", "kill", "minecraft:kick", "minecraft:ban", "minecraft:ban-ip",
            "minecraft:kill", "essentials:kick", "essentials:ban", "essentials:banip", "essentials:tempban", "litebans:ban",
            "litebans:kick", "litebans:tempban", "litebans:ipban", "litebans:mute", "advancedban:ban", "advancedban:kick",
            "advancedban:tempban", "deop", "minecraft:deop"));

    private volatile Map<String, String> staff = Collections.emptyMap(); // lower-case name -> role label
    private volatile Set<String> opStaff = Collections.emptySet(); // lower-case names whose role may be made operator
    private final Set<String> grantedOps = Collections.synchronizedSet(new HashSet<String>()); // ops this plugin gave
    private final Set<String> vanished = Collections.synchronizedSet(new HashSet<String>()); // lower-case names
    private volatile Set<String> quietStaff = Collections.emptySet(); // no join announcement
    private volatile Set<String> noBadgeStaff = Collections.emptySet(); // no floating tag
    private final Set<String> staffChatMode = Collections.synchronizedSet(new HashSet<String>()); // chat goes to /sc
    private final Map<UUID, Entity> badges = new ConcurrentHashMap<>(); // floating tags (text displays)
    private Class<? extends Entity> textDisplay; // null before 1.19.4 (and on Folia): then no floating tag
    private static final String BADGE_TAG = "th_badge";
    private static final String FLOAT_TEAM = "th_staff_f";
    private File grantedFile;
    private File actionsFile;
    private volatile Map<String, Creator> creators = Collections.emptyMap(); // lower-case name -> label and perks
    private File creatorsFile;
    private long creatorsModified = -2;
    private volatile Map<String, String> founders = Collections.emptyMap(); // lower-case name -> tier
    private File foundersFile;
    private long foundersModified = -2;
    private volatile boolean proxyTrusted; // Tree Host put this server behind its owner's proxy, which checks accounts
    private volatile String[] motdFrames = new String[0]; // the owner's MOTD (several frames = animated)
    private volatile int motdInterval = 3;
    private File motdFile;
    private long motdModified = -2;
    private File staffFile;
    private long lastModified = -2;
    private Timer timer;
    private boolean components;
    private boolean folia;

    @Override
    public void onEnable() {
        staffFile = new File(getDataFolder(), "staff.txt");
        creatorsFile = new File(getDataFolder(), "creators.txt");
        foundersFile = new File(getDataFolder(), "founders.txt");
        motdFile = new File(getDataFolder(), "motd.txt");
        grantedFile = new File(getDataFolder(), "granted-ops.txt");
        actionsFile = new File(getDataFolder(), "staff-actions.log");
        loadGrantedOps();
        components = classExists("net.md_5.bungee.api.chat.TextComponent") && classExists("org.bukkit.entity.Player$Spigot");
        folia = classExists("io.papermc.paper.threadedregions.RegionizedServer");
        reload();
        reloadCreators();
        reloadFounders();
        reloadMotd();
        getServer().getPluginManager().registerEvents(this, this);
        setupBadges();
        timer = new Timer("TreeHostStaff", true);
        timer.scheduleAtFixedRate(new TimerTask() {
            @Override
            public void run() {
                reload();
                reloadCreators();
                reloadFounders();
                reloadMotd();
                runSync(TreeHostStaff.this::undoBans);
                runSync(TreeHostStaff.this::syncOps);
            }
        }, 5000L, 5000L);
        // Ops left over from a crash (the staff member wasn't here to leave): take them back now.
        runSync(this::syncOps);
        getLogger().info("Tree Host staff protection is active (" + staff.size() + " staff, " + creators.size() + " creators, " + (trusted() ? "names verified" : "offline mode: no staff powers") + ").");
    }

    @Override
    public void onDisable() {
        if (timer != null) timer.cancel();
        for (Entity e : badges.values()) removeEntity(e);
        badges.clear();
        // Stopping: staff stop being operator (they get it back when they join again).
        for (String name : new HashSet<>(grantedOps)) deop(name);
    }

    // ---------- the staff list ----------

    private void reload() {
        long m = staffFile.exists() ? staffFile.lastModified() : -1;
        if (m == lastModified) return;
        lastModified = m;
        Map<String, String> next = new HashMap<>();
        Set<String> ops = new HashSet<>();
        Set<String> quiet = new HashSet<>();
        Set<String> nobadge = new HashSet<>();
        boolean trust = false;
        if (m >= 0) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(staffFile), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    line = line.trim();
                    if (line.equals("#trust=proxy")) trust = true;
                    if (line.startsWith("#op=")) ops.add(line.substring(4).trim().toLowerCase(Locale.ROOT));
                    if (line.startsWith("#quiet=")) quiet.add(line.substring(7).trim().toLowerCase(Locale.ROOT));
                    if (line.startsWith("#nobadge=")) nobadge.add(line.substring(9).trim().toLowerCase(Locale.ROOT));
                    if (line.isEmpty() || line.startsWith("#")) continue;
                    String[] parts = line.split("\\|", 2);
                    String name = parts[0].trim();
                    if (!name.matches("[A-Za-z0-9_]{3,16}")) continue;
                    next.put(name.toLowerCase(Locale.ROOT), parts.length > 1 && !parts[1].trim().isEmpty() ? parts[1].trim() : "Staff");
                }
            } catch (Exception e) {
                getLogger().warning("Could not read the Tree Host staff list: " + e.getMessage());
            }
        }
        staff = next;
        opStaff = ops;
        quietStaff = quiet;
        noBadgeStaff = nobadge;
        proxyTrusted = trust;
    }

    // ---------- creators (YouTubers) ----------

    private static final class Creator {
        final String label;
        final Set<String> perks;

        Creator(String label, Set<String> perks) {
            this.label = label;
            this.perks = perks;
        }

        boolean has(String perk) {
            return perks.contains(perk);
        }

        /** "▶ YOUTUBER " in red, for nametags, the player list and chat. */
        String badge() {
            return ChatColor.RED + "" + ChatColor.BOLD + "▶ " + label.toUpperCase(Locale.ROOT) + " " + ChatColor.RESET;
        }
    }

    private void reloadCreators() {
        long m = creatorsFile.exists() ? creatorsFile.lastModified() : -1;
        if (m == creatorsModified) return;
        creatorsModified = m;
        Map<String, Creator> next = new HashMap<>();
        if (m >= 0) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(creatorsFile), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty() || line.startsWith("#")) continue;
                    String[] parts = line.split("\\|", 3);
                    String name = parts[0].trim();
                    if (!name.matches("[A-Za-z0-9_]{3,16}")) continue;
                    String label = parts.length > 1 && parts[1].trim().matches("[A-Za-z0-9 ]{1,16}") ? parts[1].trim() : "YouTuber";
                    Set<String> perks = new HashSet<>();
                    if (parts.length > 2) for (String p : parts[2].split(",")) if (!p.trim().isEmpty()) perks.add(p.trim().toLowerCase(Locale.ROOT));
                    next.put(name.toLowerCase(Locale.ROOT), new Creator(label, perks));
                }
            } catch (Exception e) {
                getLogger().warning("Could not read the Tree Host creator list: " + e.getMessage());
            }
        }
        creators = next;
    }

    // ---------- launch fund supporters ----------

    private void reloadFounders() {
        long m = foundersFile.exists() ? foundersFile.lastModified() : -1;
        if (m == foundersModified) return;
        foundersModified = m;
        Map<String, String> next = new HashMap<>();
        if (m >= 0) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(foundersFile), StandardCharsets.UTF_8))) {
                String line;
                while ((line = r.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty() || line.startsWith("#")) continue;
                    String[] parts = line.split("\\|", 2);
                    String name = parts[0].trim();
                    String tier = parts.length > 1 ? parts[1].trim().toLowerCase(Locale.ROOT) : "supporter";
                    if (!name.matches("[A-Za-z0-9_]{3,16}") || !tier.matches("supporter|founder|legend")) continue;
                    next.put(name.toLowerCase(Locale.ROOT), tier);
                }
            } catch (Exception e) {
                getLogger().warning("Could not read the Tree Host supporter list: " + e.getMessage());
            }
        }
        founders = next;
    }

    /** A supporter's tier (null for everyone else, staff, creators with a badge, and where names can't be trusted). */
    private String founderOf(String name) {
        if (name == null || !trusted() || roleOf(name) != null) return null;
        Creator c = creators.get(name.toLowerCase(Locale.ROOT));
        if (c != null && c.has("badge")) return null;
        return founders.get(name.toLowerCase(Locale.ROOT));
    }

    private static String founderBadge(String tier) {
        switch (tier) {
            case "legend": return ChatColor.LIGHT_PURPLE + "" + ChatColor.BOLD + "✦ LEGEND " + ChatColor.RESET;
            case "founder": return ChatColor.GOLD + "" + ChatColor.BOLD + "★ FOUNDER " + ChatColor.RESET;
            default: return ChatColor.AQUA + "" + ChatColor.BOLD + "♥ SUPPORTER " + ChatColor.RESET;
        }
    }

    /** A supporter joins: their badge in the player list and above their head. */
    private void founderJoined(Player p) {
        String tier = founderOf(p.getName());
        if (tier == null) return;
        String badge = founderBadge(tier);
        try {
            p.setPlayerListName(badge + ChatColor.WHITE + p.getName());
        } catch (Throwable ignored) {
        }
        try {
            Scoreboard board = getServer().getScoreboardManager().getMainScoreboard();
            Team team = board.getTeam("th_fund_" + tier);
            if (team == null) team = board.registerNewTeam("th_fund_" + tier);
            team.setPrefix(badge);
            try {
                team.setColor(ChatColor.WHITE);
            } catch (Throwable ignored) {
            }
            team.addEntry(p.getName());
        } catch (Throwable ignored) {
            // Folia has no scoreboards; the chat and player list badges still work.
        }
    }

    /** A creator's perks (null for everyone else, for staff, and on servers where names can't be trusted). */
    private Creator creatorOf(String name) {
        if (name == null || !trusted() || roleOf(name) != null) return null;
        return creators.get(name.toLowerCase(Locale.ROOT));
    }

    /** motd.txt from Tree Host: "#interval=3", then frames (1-2 lines each, section codes) separated by "---". */
    private void reloadMotd() {
        long m = motdFile.exists() ? motdFile.lastModified() : -1;
        if (m == motdModified) return;
        motdModified = m;
        java.util.List<String> frames = new java.util.ArrayList<>();
        int interval = 3;
        if (m >= 0) {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(motdFile), StandardCharsets.UTF_8))) {
                StringBuilder frame = new StringBuilder();
                String line;
                while ((line = r.readLine()) != null) {
                    if (line.startsWith("#interval=")) {
                        try {
                            interval = Math.max(1, Math.min(60, Integer.parseInt(line.substring(10).trim())));
                        } catch (NumberFormatException ignored) {
                        }
                        continue;
                    }
                    if (line.equals("---")) {
                        if (frame.length() > 0) frames.add(frame.toString());
                        frame.setLength(0);
                        continue;
                    }
                    if (frame.length() > 0) frame.append("\n");
                    frame.append(line);
                }
                if (frame.length() > 0) frames.add(frame.toString());
            } catch (Exception e) {
                getLogger().warning("Could not read the MOTD: " + e.getMessage());
            }
        }
        motdInterval = interval;
        motdFrames = frames.toArray(new String[0]);
    }

    /** The server list message: the owner's MOTD, a new frame every few seconds when it's animated. */
    @EventHandler(priority = EventPriority.HIGH)
    public void onPing(ServerListPingEvent e) {
        String[] frames = motdFrames;
        if (frames.length == 0) return;
        int i = (int) ((System.currentTimeMillis() / (motdInterval * 1000L)) % frames.length);
        try {
            e.setMotd(frames[i]);
        } catch (Throwable ignored) {
        }
    }

    /** Names are only trustworthy when Mojang checked them: online mode, or behind a BungeeCord/Velocity proxy. */
    private boolean trusted() {
        if (getServer().getOnlineMode() || proxyTrusted) return true;
        try {
            return getServer().spigot().getConfig().getBoolean("settings.bungeecord");
        } catch (Throwable t) {
            return false;
        }
    }

    private String roleOf(String name) {
        if (name == null || !trusted()) return null;
        return staff.get(name.toLowerCase(Locale.ROOT));
    }

    // ---------- always let staff in ----------

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onPreLogin(AsyncPlayerPreLoginEvent e) {
        if (roleOf(e.getName()) != null && e.getLoginResult() != AsyncPlayerPreLoginEvent.Result.ALLOWED) {
            e.allow();
            runSync(() -> pardon(e.getName()));
            return;
        }
        Creator c = creatorOf(e.getName());
        AsyncPlayerPreLoginEvent.Result r = e.getLoginResult();
        if (c != null && ((r == AsyncPlayerPreLoginEvent.Result.KICK_FULL && c.has("joinfull")) || (r == AsyncPlayerPreLoginEvent.Result.KICK_WHITELIST && c.has("whitelist")))) e.allow();
    }

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onLogin(PlayerLoginEvent e) {
        if (roleOf(e.getPlayer().getName()) != null && e.getResult() != PlayerLoginEvent.Result.ALLOWED) {
            e.allow();
            pardon(e.getPlayer().getName());
            return;
        }
        // Creators: only a full server or the whitelist, never a ban (that's the owner's decision).
        Creator c = creatorOf(e.getPlayer().getName());
        PlayerLoginEvent.Result r = e.getResult();
        if (c != null && ((r == PlayerLoginEvent.Result.KICK_FULL && c.has("joinfull")) || (r == PlayerLoginEvent.Result.KICK_WHITELIST && c.has("whitelist")))) e.allow();
    }

    // ---------- no kicks or bans ----------

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onKick(PlayerKickEvent e) {
        Player p = e.getPlayer();
        String role = roleOf(p.getName());
        if (role == null || stopping(e.getReason())) return;
        e.setCancelled(true);
        p.sendMessage(PREFIX + ChatColor.YELLOW + "Someone tried to kick you (" + ChatColor.stripColor(String.valueOf(e.getReason())) + "). Staff can't be kicked.");
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onPlayerCommand(PlayerCommandPreprocessEvent e) {
        if (blocked(e.getPlayer(), e.getMessage())) e.setCancelled(true);
        String role = roleOf(e.getPlayer().getName());
        // Staff chat is logged by /sc itself; everything else staff run is written down for the owner.
        if (role != null && !e.getMessage().matches("(?i)^/(sc|thchat|treehoststaff:sc|treehoststaff:thchat)( .*)?$")) {
            logAction(e.getPlayer().getName() + " (" + role + ") ran: " + e.getMessage());
        }
    }

    @EventHandler(priority = EventPriority.LOWEST)
    public void onConsoleCommand(ServerCommandEvent e) {
        if (blocked(e.getSender(), e.getCommand())) e.setCancelled(true);
    }

    /** Refuses kick / ban / kill / deop commands aimed at staff (names or their IP address). */
    private boolean blocked(CommandSender sender, String command) {
        String[] args = command.trim().replaceFirst("^/", "").split("\\s+");
        if (args.length < 2 || !KICK_BAN_COMMANDS.contains(args[0].toLowerCase(Locale.ROOT))) return false;
        // The target is the first argument that isn't a flag (e.g. "tempban -s Steve 1d"); the rest is the reason.
        String target = null;
        for (int i = 1; i < args.length && target == null; i++) if (!args[i].startsWith("-")) target = args[i];
        if (target == null) return false;
        String role = roleOf(target);
        Player online = role != null ? null : ipOwner(target);
        if (role == null && online != null) role = roleOf(online.getName());
        if (role == null) return false;
        sender.sendMessage(PREFIX + ChatColor.YELLOW + (online != null ? online.getName() : target) + " is official Tree Host staff and can't be kicked or banned.");
        return true;
    }

    private Player ipOwner(String ip) {
        if (!ip.matches("[0-9a-fA-F.:]{7,45}")) return null;
        for (Player p : getServer().getOnlinePlayers()) {
            if (p.getAddress() != null && p.getAddress().getAddress() != null && ip.equals(p.getAddress().getAddress().getHostAddress())) return p;
        }
        return null;
    }

    private void undoBans() {
        if (!trusted()) return;
        for (String name : staff.keySet()) pardon(name);
        for (Player p : getServer().getOnlinePlayers()) {
            if (roleOf(p.getName()) == null || p.getAddress() == null || p.getAddress().getAddress() == null) continue;
            String ip = p.getAddress().getAddress().getHostAddress();
            try {
                BanList ips = getServer().getBanList(BanList.Type.IP);
                if (ips.isBanned(ip)) ips.pardon(ip);
            } catch (Throwable ignored) {
            }
        }
    }

    private void pardon(String name) {
        try {
            BanList names = getServer().getBanList(BanList.Type.NAME);
            if (names.isBanned(name)) {
                names.pardon(name);
                getLogger().info("Undid a ban on Tree Host staff " + name + ".");
            }
        } catch (Throwable ignored) {
        }
    }

    // ---------- join notice and badges ----------

    @EventHandler(priority = EventPriority.HIGHEST)
    public void onJoin(PlayerJoinEvent e) {
        Player p = e.getPlayer();
        String role = roleOf(p.getName());
        if (role == null) {
            hideVanishedFrom(p);
            creatorJoined(e, p);
            founderJoined(p);
            return;
        }
        grantOp(p);
        p.sendMessage(PREFIX + ChatColor.GREEN + "Staff tools: " + ChatColor.WHITE + "/thstaff" + ChatColor.GRAY + " opens the staff menu ("
                + ChatColor.WHITE + "/sc" + ChatColor.GRAY + " staff chat, " + ChatColor.WHITE + "/thvanish" + ChatColor.GRAY + ", "
                + ChatColor.WHITE + "/thinfo" + ChatColor.GRAY + ")." + (p.isOp() ? " You're operator while you're here." : ""));
        boolean quiet = quietStaff.contains(p.getName().toLowerCase(Locale.ROOT));
        staffTeam(p);
        if (quiet) return; // their choice: a normal join message, no announcement
        e.setJoinMessage(BADGE + ChatColor.GOLD + p.getName() + ChatColor.YELLOW + " (" + role + ") joined the game");
        String text = PREFIX + ChatColor.GOLD + "" + ChatColor.BOLD + p.getName() + ChatColor.GOLD + " (" + role + ") joined. "
                + ChatColor.GREEN + "A Tree Host " + role + " has joined your server.";
        for (Player other : getServer().getOnlinePlayers()) {
            if (components) {
                try {
                    other.spigot().sendMessage(withHover(text, "Official Tree Host Staff"));
                    continue;
                } catch (Throwable ignored) {
                }
            }
            other.sendMessage(text);
        }
        getServer().getConsoleSender().sendMessage(ChatColor.stripColor(text));
    }

    /**
     * The STAFF badge in the player list and above their head. With a floating tag (1.19.4+) the normal nametag is hidden
     * (team th_staff_f) so the name isn't shown twice; without one, the nametag gets the badge as a prefix (team th_staff).
     */
    private void staffTeam(Player p) {
        try {
            p.setPlayerListName(BADGE + ChatColor.GOLD + p.getName());
        } catch (Throwable ignored) {
        }
        try {
            Scoreboard board = getServer().getScoreboardManager().getMainScoreboard();
            boolean floating = wantsBadge(p);
            Team team = board.getTeam(floating ? FLOAT_TEAM : TEAM);
            if (team == null) team = board.registerNewTeam(floating ? FLOAT_TEAM : TEAM);
            team.setPrefix(BADGE);
            try {
                team.setColor(ChatColor.GOLD);
            } catch (Throwable ignored) {
            }
            try {
                team.setOption(Team.Option.NAME_TAG_VISIBILITY, floating ? Team.OptionStatus.NEVER : Team.OptionStatus.ALWAYS);
            } catch (Throwable ignored) {
            }
            team.addEntry(p.getName());
        } catch (Throwable ignored) {
            // Folia has no scoreboards; the chat and player list badges still work.
        }
    }

    // ---------- the floating STAFF tag (a text display that follows them; they see it in third person) ----------

    @SuppressWarnings("unchecked")
    private void setupBadges() {
        if (folia) return;
        try {
            textDisplay = (Class<? extends Entity>) Class.forName("org.bukkit.entity.TextDisplay");
        } catch (Throwable t) {
            textDisplay = null;
            return;
        }
        // Tags left behind by a crash (they aren't saved, but be sure).
        for (World w : getServer().getWorlds()) {
            for (Entity e : w.getEntities()) if (e.getScoreboardTags().contains(BADGE_TAG)) e.remove();
        }
        getServer().getScheduler().runTaskTimer(this, this::moveBadges, 1L, 1L);
    }

    private boolean wantsBadge(Player p) {
        String key = p.getName().toLowerCase(Locale.ROOT);
        return textDisplay != null && roleOf(p.getName()) != null && !noBadgeStaff.contains(key);
    }

    /** Every tick: each tag sits over its player's head (made, moved to another world or removed as needed). */
    private void moveBadges() {
        for (Player p : getServer().getOnlinePlayers()) {
            String key = p.getName().toLowerCase(Locale.ROOT);
            Entity tag = badges.get(p.getUniqueId());
            boolean want = wantsBadge(p) && !vanished.contains(key) && !p.isDead() && p.getGameMode() != GameMode.SPECTATOR;
            if (!want) {
                if (tag != null) {
                    removeEntity(tag);
                    badges.remove(p.getUniqueId());
                    staffTeam(p);
                }
                continue;
            }
            Location at = p.getLocation().add(0, p.isSneaking() ? 1.85 : 2.15, 0);
            if (tag == null || !tag.isValid() || tag.getWorld() != p.getWorld()) {
                if (tag != null) removeEntity(tag);
                tag = spawnBadge(p, at);
                if (tag == null) continue;
                badges.put(p.getUniqueId(), tag);
                staffTeam(p);
            } else {
                tag.teleport(at);
            }
        }
        for (UUID id : new HashSet<>(badges.keySet())) {
            if (getServer().getPlayer(id) == null) removeEntity(badges.remove(id));
        }
    }

    private Entity spawnBadge(Player p, Location at) {
        try {
            Entity e = p.getWorld().spawn(at, textDisplay);
            call(e, "setText", String.class, BADGE + ChatColor.GOLD + p.getName());
            Class<?> billboard = Class.forName("org.bukkit.entity.Display$Billboard");
            call(e, "setBillboard", billboard, enumValue(billboard, "CENTER"));
            try {
                call(e, "setTeleportDuration", int.class, 1); // smooth movement (1.20.2+)
            } catch (Throwable ignored) {
            }
            try {
                call(e, "setPersistent", boolean.class, false);
            } catch (Throwable ignored) {
            }
            e.addScoreboardTag(BADGE_TAG);
            return e;
        } catch (Throwable t) {
            getLogger().warning("Could not show the floating STAFF tag: " + t);
            textDisplay = null; // don't try every tick
            return null;
        }
    }

    private static void removeEntity(Entity e) {
        try {
            if (e != null) e.remove();
        } catch (Throwable ignored) {
        }
    }

    private static void call(Object target, String method, Class<?> type, Object value) throws Exception {
        target.getClass().getMethod(method, type).invoke(target, value);
    }

    @SuppressWarnings({ "unchecked", "rawtypes" })
    private static Object enumValue(Class<?> type, String name) {
        return Enum.valueOf((Class) type, name);
    }

    /** A creator joins: their badge above their head and in the player list, and the announcement. */
    private void creatorJoined(PlayerJoinEvent e, Player p) {
        Creator c = creatorOf(p.getName());
        if (c == null) return;
        if (c.has("badge")) {
            try {
                p.setPlayerListName(c.badge() + ChatColor.WHITE + p.getName());
            } catch (Throwable ignored) {
            }
            try {
                Scoreboard board = getServer().getScoreboardManager().getMainScoreboard();
                Team team = board.getTeam(CREATOR_TEAM);
                if (team == null) team = board.registerNewTeam(CREATOR_TEAM);
                team.setPrefix(c.badge());
                try {
                    team.setColor(ChatColor.WHITE);
                } catch (Throwable ignored) {
                }
                team.addEntry(p.getName());
            } catch (Throwable ignored) {
                // Folia has no scoreboards; the chat and player list badges still work.
            }
        }
        if (c.has("announce")) {
            e.setJoinMessage(null);
            String text = ChatColor.RED + "" + ChatColor.BOLD + "▶ " + ChatColor.WHITE + ChatColor.BOLD + p.getName() + ChatColor.RESET + ChatColor.GRAY
                    + " joined the game. " + ChatColor.RED + c.label + ChatColor.GRAY + " on Tree Host";
            for (Player other : getServer().getOnlinePlayers()) {
                if (components) {
                    try {
                        other.spigot().sendMessage(withHover(text, "Tree Host " + c.label));
                        continue;
                    } catch (Throwable ignored) {
                    }
                }
                other.sendMessage(text);
            }
            getServer().getConsoleSender().sendMessage(ChatColor.stripColor(text));
        }
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent e) {
        String name = e.getPlayer().getName();
        vanished.remove(name.toLowerCase(Locale.ROOT));
        staffChatMode.remove(name.toLowerCase(Locale.ROOT));
        removeEntity(badges.remove(e.getPlayer().getUniqueId()));
        if (grantedOps.contains(name.toLowerCase(Locale.ROOT))) deop(name);
        String fund = founderOf(name);
        String[] teams = roleOf(name) != null ? new String[] { TEAM, FLOAT_TEAM } : creatorOf(name) != null ? new String[] { CREATOR_TEAM }
                : fund != null ? new String[] { "th_fund_" + fund } : new String[0];
        for (String team : teams) {
            try {
                Team t = getServer().getScoreboardManager().getMainScoreboard().getTeam(team);
                if (t != null) t.removeEntry(name);
            } catch (Throwable ignored) {
            }
        }
    }

    /** Staff chat: a gold STAFF badge before the name; hovering over it says "Official Tree Host Staff". */
    @EventHandler(priority = EventPriority.HIGHEST, ignoreCancelled = true)
    public void onChat(AsyncPlayerChatEvent e) {
        Player p = e.getPlayer();
        String role = roleOf(p.getName());
        if (role != null && staffChatMode.contains(p.getName().toLowerCase(Locale.ROOT))) {
            e.setCancelled(true);
            staffChat(p.getName(), e.getMessage());
            return;
        }
        if (role == null) {
            // Creators: the badge goes in front of whatever chat format the server uses (other chat plugins keep working).
            Creator c = creatorOf(p.getName());
            if (c != null && c.has("badge")) e.setFormat(c.badge() + e.getFormat());
            else {
                String tier = founderOf(p.getName());
                if (tier != null) e.setFormat(founderBadge(tier) + e.getFormat());
            }
            return;
        }
        if (!components) {
            e.setFormat(BADGE + ChatColor.GOLD + "%1$s" + ChatColor.GRAY + ": " + ChatColor.WHITE + "%2$s");
            return;
        }
        e.setCancelled(true);
        BaseComponent[] badge = new ComponentBuilder("✔ STAFF ").color(net.md_5.bungee.api.ChatColor.GOLD).bold(true)
                .event(new HoverEvent(HoverEvent.Action.SHOW_TEXT, new ComponentBuilder("Official Tree Host Staff\n").color(net.md_5.bungee.api.ChatColor.GREEN).bold(true)
                        .append(role).color(net.md_5.bungee.api.ChatColor.GOLD).bold(false).create()))
                .create();
        BaseComponent[] rest = new ComponentBuilder(p.getName()).color(net.md_5.bungee.api.ChatColor.GOLD).bold(false).event((HoverEvent) null)
                .append(": ").color(net.md_5.bungee.api.ChatColor.GRAY)
                .append(e.getMessage()).color(net.md_5.bungee.api.ChatColor.WHITE).create();
        BaseComponent[] line = new BaseComponent[badge.length + rest.length];
        System.arraycopy(badge, 0, line, 0, badge.length);
        System.arraycopy(rest, 0, line, badge.length, rest.length);
        for (Player r : e.getRecipients()) {
            try {
                r.spigot().sendMessage(line);
            } catch (Throwable t) {
                r.sendMessage(BADGE + ChatColor.GOLD + p.getName() + ChatColor.GRAY + ": " + ChatColor.WHITE + e.getMessage());
            }
        }
        getServer().getConsoleSender().sendMessage("[STAFF] " + p.getName() + ": " + e.getMessage());
    }

    // ---------- operator while staff are on the server ----------

    private boolean mayOp(String name) {
        return name != null && roleOf(name) != null && opStaff.contains(name.toLowerCase(Locale.ROOT));
    }

    /** Makes a staff member operator (unless the owner already did: then it stays theirs to manage). */
    private void grantOp(Player p) {
        if (!mayOp(p.getName()) || p.isOp()) return;
        try {
            p.setOp(true);
            grantedOps.add(p.getName().toLowerCase(Locale.ROOT));
            saveGrantedOps();
            logAction(p.getName() + " was made operator (Tree Host staff; taken away again when they leave).");
        } catch (Throwable t) {
            getLogger().warning("Could not make " + p.getName() + " operator: " + t.getMessage());
        }
    }

    private void deop(String name) {
        try {
            Player online = getServer().getPlayerExact(name);
            OfflinePlayer target = online != null ? online : getServer().getOfflinePlayer(name);
            if (target.isOp()) target.setOp(false);
        } catch (Throwable ignored) {
        }
        grantedOps.remove(name.toLowerCase(Locale.ROOT));
        saveGrantedOps();
    }

    /** Ops this plugin gave go away when the person left, or isn't staff (or allowed op) any more. */
    private void syncOps() {
        for (String name : new HashSet<>(grantedOps)) {
            Player p = getServer().getPlayerExact(name);
            if (p == null || !mayOp(name)) deop(name);
        }
        for (Player p : getServer().getOnlinePlayers()) if (mayOp(p.getName())) grantOp(p);
    }

    private void loadGrantedOps() {
        if (!grantedFile.exists()) return;
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(grantedFile), StandardCharsets.UTF_8))) {
            String line;
            while ((line = r.readLine()) != null) if (line.trim().matches("[A-Za-z0-9_]{3,16}")) grantedOps.add(line.trim().toLowerCase(Locale.ROOT));
        } catch (Exception e) {
            getLogger().warning("Could not read granted-ops.txt: " + e.getMessage());
        }
    }

    private void saveGrantedOps() {
        try {
            getDataFolder().mkdirs();
            try (Writer w = new OutputStreamWriter(new FileOutputStream(grantedFile), StandardCharsets.UTF_8)) {
                w.write("# Tree Host staff this plugin made operator (taken away when they leave). Don't edit.\n");
                synchronized (grantedOps) {
                    for (String n : grantedOps) w.write(n + "\n");
                }
            }
        } catch (Exception e) {
            getLogger().warning("Could not save granted-ops.txt: " + e.getMessage());
        }
    }

    /** What staff did on this server: in the console and in staff-actions.log, for the owner to read. */
    private void logAction(String text) {
        getLogger().info("[Tree Host staff] " + text);
        try {
            getDataFolder().mkdirs();
            try (Writer w = new OutputStreamWriter(new FileOutputStream(actionsFile, true), StandardCharsets.UTF_8)) {
                w.write(new SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new Date()) + "  " + text + "\n");
            }
        } catch (Exception ignored) {
        }
    }

    // ---------- staff commands ----------

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        String name = command.getName().toLowerCase(Locale.ROOT);
        String role = sender instanceof Player ? roleOf(sender.getName()) : "Console";
        if (role == null) {
            sender.sendMessage(PREFIX + ChatColor.RED + "That command is for official Tree Host staff.");
            return true;
        }
        switch (name) {
            case "thchat":
                if (args.length == 0) {
                    if (sender instanceof Player) toggleStaffChat((Player) sender);
                    else sender.sendMessage("Usage: sc <message>");
                    return true;
                }
                staffChat(sender.getName(), String.join(" ", args));
                if (!(sender instanceof Player)) sender.sendMessage("[Staff] " + sender.getName() + ": " + String.join(" ", args));
                return true;
            case "thvanish":
                if (!(sender instanceof Player)) {
                    sender.sendMessage("Only players can vanish.");
                    return true;
                }
                toggleVanish((Player) sender);
                return true;
            case "thinfo":
                sendInfo(sender);
                return true;
            default:
                if (sender instanceof Player && !(args.length > 0 && args[0].equalsIgnoreCase("help"))) {
                    openMain((Player) sender);
                    return true;
                }
                sender.sendMessage(PREFIX + ChatColor.GREEN + "Official Tree Host staff tools" + ChatColor.GRAY + " (" + role + ")");
                sender.sendMessage(ChatColor.WHITE + "  /thstaff" + ChatColor.GRAY + "  the staff menu (/thstaff help: this list)");
                sender.sendMessage(ChatColor.WHITE + "  /sc <message>" + ChatColor.GRAY + "  chat with the other Tree Host staff on this server (/sc alone: all your chat goes there)");
                sender.sendMessage(ChatColor.WHITE + "  /thvanish" + ChatColor.GRAY + "  hide from players while you look into a problem");
                sender.sendMessage(ChatColor.WHITE + "  /thinfo" + ChatColor.GRAY + "  TPS, memory, players, plugins and version at a glance");
                sender.sendMessage(ChatColor.GRAY + "  You " + (sender instanceof Player && ((Player) sender).isOp() ? "are" : "aren't") + " operator. Staff can't be kicked or banned."
                        + " Everything you run here is logged for the owner.");
                return true;
        }
    }

    // ---------- shared actions (commands and the menu) ----------

    private void staffChat(String from, String msg) {
        String line = ChatColor.GOLD + "" + ChatColor.BOLD + "[Staff] " + ChatColor.GOLD + from + ChatColor.GRAY + ": " + ChatColor.AQUA + msg;
        for (Player p : getServer().getOnlinePlayers()) if (roleOf(p.getName()) != null) p.sendMessage(line);
        logAction("[staff chat] " + from + ": " + msg);
    }

    private void toggleStaffChat(Player p) {
        String key = p.getName().toLowerCase(Locale.ROOT);
        boolean on = !staffChatMode.contains(key);
        if (on) staffChatMode.add(key);
        else staffChatMode.remove(key);
        p.sendMessage(PREFIX + (on ? ChatColor.GREEN + "Staff chat mode on: everything you type goes to staff only. /sc again to turn it off."
                : ChatColor.YELLOW + "Staff chat mode off: your chat is public again."));
    }

    private void toggleVanish(Player me) {
        String key = me.getName().toLowerCase(Locale.ROOT);
        boolean hide = !vanished.contains(key);
        if (hide) vanished.add(key);
        else vanished.remove(key);
        for (Player other : getServer().getOnlinePlayers()) {
            if (other == me || roleOf(other.getName()) != null) continue;
            try {
                if (hide) other.hidePlayer(this, me);
                else other.showPlayer(this, me);
            } catch (Throwable ignored) {
            }
        }
        me.sendMessage(PREFIX + (hide ? ChatColor.GREEN + "You're vanished: players can't see you (staff still can). /thvanish again to show yourself."
                : ChatColor.YELLOW + "You're visible again."));
        logAction(me.getName() + (hide ? " vanished." : " is visible again."));
    }

    /** A setting the staff member changed in the menu: used here at once, and saved to their account by Tree Host. */
    private void setPref(Player p, String pref, boolean on) {
        String key = p.getName().toLowerCase(Locale.ROOT);
        if (pref.equals("announce")) quietStaff = withOrWithout(quietStaff, key, !on);
        if (pref.equals("badge")) noBadgeStaff = withOrWithout(noBadgeStaff, key, !on);
        if (pref.equals("autoOp")) {
            if (!on && grantedOps.contains(key)) deop(p.getName());
            if (on && !opStaff.contains(key)) p.sendMessage(PREFIX + ChatColor.YELLOW + "Saved. You're made operator the next time you join, if your role allows it.");
        }
        try {
            getDataFolder().mkdirs();
            try (Writer w = new OutputStreamWriter(new FileOutputStream(new File(getDataFolder(), "prefs-out.txt"), true), StandardCharsets.UTF_8)) {
                w.write(p.getName() + "|" + pref + "|" + (on ? "on" : "off") + "\n");
            }
        } catch (Exception e) {
            getLogger().warning("Could not save the setting: " + e.getMessage());
        }
        if (pref.equals("badge")) staffTeam(p);
    }

    private static Set<String> withOrWithout(Set<String> set, String key, boolean add) {
        Set<String> next = new HashSet<>(set);
        if (add) next.add(key);
        else next.remove(key);
        return next;
    }

    // ---------- the staff menu (/thstaff) ----------

    private static final class Menu implements InventoryHolder {
        final String kind; // main | players | player
        final String target; // the player a "player" menu is about
        Inventory inventory;

        Menu(String kind, String target) {
            this.kind = kind;
            this.target = target;
        }

        @Override
        public Inventory getInventory() {
            return inventory;
        }
    }

    private static Material mat(String... names) {
        for (String n : names) {
            Material m = Material.matchMaterial(n);
            if (m != null) return m;
        }
        return Material.PAPER;
    }

    private static ItemStack item(Material m, String name, String... lore) {
        ItemStack it = new ItemStack(m);
        ItemMeta meta = it.getItemMeta();
        if (meta != null) {
            meta.setDisplayName(ChatColor.RESET + name);
            java.util.List<String> lines = new java.util.ArrayList<>();
            for (String l : lore) lines.add(ChatColor.GRAY + l);
            meta.setLore(lines);
            it.setItemMeta(meta);
        }
        return it;
    }

    private static String onOff(boolean on) {
        return on ? ChatColor.GREEN + "On" : ChatColor.RED + "Off";
    }

    private Inventory menu(String kind, String target, int size, String title) {
        Menu holder = new Menu(kind, target);
        holder.inventory = getServer().createInventory(holder, size, title);
        return holder.inventory;
    }

    private void openMain(Player p) {
        String key = p.getName().toLowerCase(Locale.ROOT);
        boolean op = mayOp(p.getName());
        Inventory inv = menu("main", null, 27, ChatColor.DARK_GREEN + "Tree Host Staff");
        inv.setItem(10, item(mat("ENDER_EYE"), ChatColor.AQUA + "Vanish: " + onOff(vanished.contains(key)), "Hide from players while you", "look into a problem. Staff still see you."));
        inv.setItem(11, item(mat("GRASS_BLOCK", "GRASS"), ChatColor.AQUA + "Game mode: " + ChatColor.WHITE + p.getGameMode().name().toLowerCase(Locale.ROOT),
                op ? "Click: survival → creative → spectator" : "Your role can't change game modes."));
        inv.setItem(12, item(mat("CLOCK", "WATCH"), ChatColor.AQUA + "Server health", "TPS, memory, players and plugins"));
        inv.setItem(13, item(mat("PLAYER_HEAD", "SKULL_ITEM"), ChatColor.AQUA + "Players (" + getServer().getOnlinePlayers().size() + ")", "Teleport to someone, see their", "inventory or ender chest, heal them"));
        inv.setItem(14, item(mat("WRITABLE_BOOK", "BOOK_AND_QUILL"), ChatColor.AQUA + "Staff chat mode: " + onOff(staffChatMode.contains(key)), "On: everything you type", "goes to staff only (/sc)"));
        inv.setItem(15, item(mat("BELL", "NOTE_BLOCK"), ChatColor.GOLD + "Announce me when I join: " + onOff(!quietStaff.contains(key)), "Your setting on every server", "(also in Account on the website)"));
        inv.setItem(16, item(mat("NAME_TAG"), ChatColor.GOLD + "STAFF tag over my head: " + onOff(!noBadgeStaff.contains(key)),
                textDisplay != null ? "Everyone sees it, and you see it" : "This server is too old for the floating", textDisplay != null ? "yourself in third person (F5)" : "tag (1.19.4+): your nametag has the badge"));
        inv.setItem(17, item(mat("COMMAND_BLOCK", "COMMAND"), ChatColor.GOLD + "Operator while I'm here: " + onOff(op || grantedOps.contains(key)),
                "Taken away when you leave.", "Only if your role may run commands."));
        inv.setItem(22, item(mat("BARRIER"), ChatColor.RED + "Close"));
        p.openInventory(inv);
    }

    private void openPlayers(Player p) {
        Inventory inv = menu("players", null, 54, ChatColor.DARK_GREEN + "Players");
        int slot = 0;
        for (Player other : getServer().getOnlinePlayers()) {
            if (slot >= 45) break;
            ItemStack head = item(mat("PLAYER_HEAD", "SKULL_ITEM"), (roleOf(other.getName()) != null ? ChatColor.GOLD : ChatColor.WHITE) + other.getName(),
                    "Game mode: " + other.getGameMode().name().toLowerCase(Locale.ROOT), "Health: " + Math.round(other.getHealth()) + " / 20", "Click for actions");
            try {
                SkullMeta meta = (SkullMeta) head.getItemMeta();
                meta.setOwningPlayer(other);
                head.setItemMeta(meta);
            } catch (Throwable ignored) {
            }
            inv.setItem(slot++, head);
        }
        inv.setItem(49, item(mat("ARROW"), ChatColor.YELLOW + "Back"));
        p.openInventory(inv);
    }

    private void openPlayer(Player p, Player target) {
        boolean op = mayOp(p.getName());
        Location l = target.getLocation();
        Inventory inv = menu("player", target.getName(), 27, ChatColor.DARK_GREEN + target.getName());
        inv.setItem(10, item(mat("ENDER_PEARL"), ChatColor.AQUA + "Teleport to " + target.getName(), l.getWorld().getName() + " " + l.getBlockX() + ", " + l.getBlockY() + ", " + l.getBlockZ()));
        inv.setItem(11, item(mat("CHEST"), ChatColor.AQUA + "Open their inventory", op ? "You can move items" : "Your role can't do this"));
        inv.setItem(12, item(mat("ENDER_CHEST"), ChatColor.AQUA + "Open their ender chest", op ? "You can move items" : "Your role can't do this"));
        inv.setItem(13, item(mat("GOLDEN_APPLE"), ChatColor.AQUA + "Heal and feed", op ? "Full health and hunger" : "Your role can't do this"));
        inv.setItem(14, item(mat("COMPASS"), ChatColor.AQUA + "Spectate", op ? "Spectator mode, at their side" : "Your role can't do this"));
        inv.setItem(16, item(mat("PAPER"), ChatColor.WHITE + target.getName(), "Game mode: " + target.getGameMode().name().toLowerCase(Locale.ROOT),
                "Health: " + Math.round(target.getHealth()) + " / 20, food " + target.getFoodLevel() + " / 20", "Operator: " + (target.isOp() ? "yes" : "no")));
        inv.setItem(22, item(mat("ARROW"), ChatColor.YELLOW + "Back"));
        p.openInventory(inv);
    }

    @EventHandler(ignoreCancelled = true)
    public void onMenuDrag(InventoryDragEvent e) {
        if (e.getInventory().getHolder() instanceof Menu) e.setCancelled(true);
    }

    @EventHandler
    public void onMenuClick(InventoryClickEvent e) {
        if (!(e.getInventory().getHolder() instanceof Menu) || !(e.getWhoClicked() instanceof Player)) return;
        e.setCancelled(true);
        Player p = (Player) e.getWhoClicked();
        Menu m = (Menu) e.getInventory().getHolder();
        if (roleOf(p.getName()) == null || e.getClickedInventory() != e.getInventory()) return;
        int slot = e.getRawSlot();
        String key = p.getName().toLowerCase(Locale.ROOT);
        boolean op = mayOp(p.getName());
        switch (m.kind) {
            case "main":
                if (slot == 10) {
                    toggleVanish(p);
                    openMain(p);
                } else if (slot == 11 && op) {
                    GameMode next = p.getGameMode() == GameMode.SURVIVAL ? GameMode.CREATIVE : p.getGameMode() == GameMode.CREATIVE ? GameMode.SPECTATOR : GameMode.SURVIVAL;
                    p.setGameMode(next);
                    logAction(p.getName() + " switched to " + next.name().toLowerCase(Locale.ROOT) + " mode (staff menu).");
                    openMain(p);
                } else if (slot == 12) {
                    p.closeInventory();
                    sendInfo(p);
                } else if (slot == 13) openPlayers(p);
                else if (slot == 14) {
                    toggleStaffChat(p);
                    openMain(p);
                } else if (slot == 15) {
                    setPref(p, "announce", quietStaff.contains(key));
                    openMain(p);
                } else if (slot == 16) {
                    setPref(p, "badge", noBadgeStaff.contains(key));
                    openMain(p);
                } else if (slot == 17) {
                    boolean on = !(op || grantedOps.contains(key));
                    setPref(p, "autoOp", on);
                    if (on && opStaff.contains(key)) grantOp(p);
                    openMain(p);
                } else if (slot == 22) p.closeInventory();
                return;
            case "players":
                if (slot == 49) {
                    openMain(p);
                    return;
                }
                ItemStack it = e.getCurrentItem();
                if (it == null || it.getItemMeta() == null) return;
                Player target = getServer().getPlayerExact(ChatColor.stripColor(it.getItemMeta().getDisplayName()));
                if (target != null) openPlayer(p, target);
                return;
            case "player":
                Player t = getServer().getPlayerExact(m.target);
                if (slot == 22) {
                    openPlayers(p);
                    return;
                }
                if (t == null) {
                    p.sendMessage(PREFIX + ChatColor.YELLOW + m.target + " left the server.");
                    p.closeInventory();
                    return;
                }
                if (slot == 10) {
                    p.closeInventory();
                    if (folia) {
                        p.sendMessage(PREFIX + ChatColor.YELLOW + "On Folia, use /tp " + t.getName() + ".");
                        return;
                    }
                    p.teleport(t.getLocation());
                    logAction(p.getName() + " teleported to " + t.getName() + " (staff menu).");
                } else if (slot >= 11 && slot <= 14 && !op) {
                    p.sendMessage(PREFIX + ChatColor.YELLOW + "Your role can't do that on customers' servers.");
                } else if (slot == 11) {
                    p.openInventory(t.getInventory());
                    logAction(p.getName() + " opened " + t.getName() + "'s inventory (staff menu).");
                } else if (slot == 12) {
                    p.openInventory(t.getEnderChest());
                    logAction(p.getName() + " opened " + t.getName() + "'s ender chest (staff menu).");
                } else if (slot == 13) {
                    try {
                        t.setHealth(t.getMaxHealth());
                    } catch (Throwable ignored) {
                    }
                    t.setFoodLevel(20);
                    t.setFireTicks(0);
                    p.sendMessage(PREFIX + ChatColor.GREEN + "Healed and fed " + t.getName() + ".");
                    logAction(p.getName() + " healed and fed " + t.getName() + " (staff menu).");
                } else if (slot == 14) {
                    p.closeInventory();
                    p.setGameMode(GameMode.SPECTATOR);
                    if (!folia) p.teleport(t.getLocation());
                    logAction(p.getName() + " is spectating " + t.getName() + " (staff menu).");
                }
                return;
            default:
        }
    }

    /** Server health for staff: TPS (Paper), memory, players, plugins, version. */
    private void sendInfo(CommandSender to) {
        Runtime rt = Runtime.getRuntime();
        long used = (rt.totalMemory() - rt.freeMemory()) / 1048576L, max = rt.maxMemory() / 1048576L;
        String tps = "not available on this server type";
        try {
            double[] t = (double[]) getServer().getClass().getMethod("getTPS").invoke(getServer());
            tps = String.format(Locale.ROOT, "%.1f, %.1f, %.1f (1, 5, 15 min)", Math.min(20, t[0]), Math.min(20, t[1]), Math.min(20, t[2]));
        } catch (Throwable ignored) {
        }
        StringBuilder plugins = new StringBuilder();
        org.bukkit.plugin.Plugin[] list = getServer().getPluginManager().getPlugins();
        for (org.bukkit.plugin.Plugin pl : list) {
            if (plugins.length() > 0) plugins.append(", ");
            plugins.append(pl.isEnabled() ? ChatColor.WHITE : ChatColor.RED).append(pl.getName()).append(ChatColor.GRAY);
        }
        to.sendMessage(PREFIX + ChatColor.GREEN + "Server health");
        to.sendMessage(ChatColor.GRAY + "  Version: " + ChatColor.WHITE + getServer().getName() + " " + getServer().getBukkitVersion());
        to.sendMessage(ChatColor.GRAY + "  TPS: " + ChatColor.WHITE + tps);
        to.sendMessage(ChatColor.GRAY + "  Memory: " + ChatColor.WHITE + used + " / " + max + " MB" + (used * 100 / Math.max(1, max) > 85 ? ChatColor.RED + " (nearly full)" : ""));
        to.sendMessage(ChatColor.GRAY + "  Players: " + ChatColor.WHITE + getServer().getOnlinePlayers().size() + " / " + getServer().getMaxPlayers()
                + ChatColor.GRAY + "  View distance: " + ChatColor.WHITE + getServer().getViewDistance() + ChatColor.GRAY + "  Online mode: " + ChatColor.WHITE + getServer().getOnlineMode());
        to.sendMessage(ChatColor.GRAY + "  Plugins (" + list.length + ", red = off): " + plugins);
    }

    /** Someone who isn't staff joins: staff who vanished stay hidden from them. */
    private void hideVanishedFrom(Player newcomer) {
        synchronized (vanished) {
            for (String n : vanished) {
                Player v = getServer().getPlayerExact(n);
                if (v == null) continue;
                try {
                    newcomer.hidePlayer(this, v);
                } catch (Throwable ignored) {
                }
            }
        }
    }

    // ---------- helpers ----------

    private static BaseComponent[] withHover(String legacy, String hover) {
        BaseComponent[] parts = TextComponent.fromLegacyText(legacy);
        HoverEvent ev = new HoverEvent(HoverEvent.Action.SHOW_TEXT, new ComponentBuilder(hover).color(net.md_5.bungee.api.ChatColor.GREEN).create());
        for (BaseComponent c : parts) c.setHoverEvent(ev);
        return parts;
    }

    /** True while the server is shutting down (its "server closed" kicks must go through). */
    private boolean stopping(String reason) {
        try {
            Object r = Bukkit.class.getMethod("isStopping").invoke(null);
            if (Boolean.TRUE.equals(r)) return true;
        } catch (Throwable ignored) {
        }
        String why = String.valueOf(reason).toLowerCase(Locale.ROOT);
        return why.contains("server closed") || why.contains("shutting down") || why.contains("restarting") || why.contains("server is stopping");
    }

    private void runSync(Runnable task) {
        if (folia || !isEnabled()) {
            try {
                task.run();
            } catch (Throwable ignored) {
            }
            return;
        }
        try {
            getServer().getScheduler().runTask(this, task);
        } catch (Throwable ignored) {
        }
    }

    private static boolean classExists(String name) {
        try {
            Class.forName(name);
            return true;
        } catch (Throwable t) {
            return false;
        }
    }
}
