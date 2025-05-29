require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder } = require('discord.js');
const axios = require('axios');
const express = require('express');
const cors = require('cors');

// Initialize Express server
const app = express();
const port = process.env.PORT || 3000;

// CORS Configuration
const allowedOrigins = ['', '']; // Add the IP address to allowed origins

// CORS middleware setup
const corsOptions = {
  origin: (origin, callback) => {
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'), false);
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
};

// Apply CORS middleware
app.use(cors(corsOptions));

// Catch-all route for Access Denied
app.use((err, req, res, next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).sendFile('access-denied.html'); // don't change
  }
  next(err);
});

app.use(express.json());

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Cache for posts and other settings
const cache = {
  posts: {},
  lastUpdated: null,
  refreshInterval: 600000, // Default 10 minutes
  isApiEnabled: true,
  isRanEnabled: true,
  isRanSlugEnabled: true,
  allowedRoleID: 'putallowroleidhere', // Set the role ID for command access
};

// Refresh posts cache
async function refreshPostsCache() {
  try {
    console.log('Refreshing posts cache...');
    const posts = await fetchAllPosts();
    cache.posts = posts.reduce((acc, post) => {
      acc[normalizeSlug(post.slug)] = post;
      return acc;
    }, {});
    cache.lastUpdated = Date.now();
    console.log('Posts cache refreshed.');
  } catch (error) {
    console.error('Error refreshing posts cache:', error.message);
  }
}

// Command for updating the refresh interval
async function updateRefreshInterval(newInterval) {
  cache.refreshInterval = newInterval;
  clearInterval(refreshInterval);
  setInterval(refreshPostsCache, cache.refreshInterval);
  console.log(`Refresh interval updated to ${newInterval}ms`);
}

// Discord slash commands
client.on('ready', async () => {
  console.log('Bot is online!');

  const commands = [
    new SlashCommandBuilder()
      .setName('refresh')
      .setDescription('Manually refresh the posts cache')
      .addIntegerOption(option =>
        option.setName('interval')
          .setDescription('Set the refresh interval in milliseconds')
          .setRequired(false)
      ),
    new SlashCommandBuilder()
      .setName('disable-api')
      .setDescription('Disable the API connection between site and the server'),
    new SlashCommandBuilder()
      .setName('enable-api')
      .setDescription('Enable the API connection between site and the server'),
    new SlashCommandBuilder()
      .setName('disable-ran')
      .setDescription('Disable the /ran page and its routes'),
    new SlashCommandBuilder()
      .setName('enable-ran')
      .setDescription('Enable the /ran page and its routes'),
    new SlashCommandBuilder()
      .setName('disable-ran-slug')
      .setDescription('Disable the /ran/{slug} page'),
    new SlashCommandBuilder()
      .setName('enable-ran-slug')
      .setDescription('Enable the /ran/{slug} page'),
    new SlashCommandBuilder()
      .setName('control-posts')
      .setDescription('Control which posts are shown or hidden')
      .addStringOption(option =>
        option.setName('action')
          .setDescription('Action to perform (show, hide, keep)')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('slug')
          .setDescription('Slug of the post')
          .setRequired(true)
      ),
  ];

  await client.application.commands.set(commands);
});

// Slash command handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName, options, member } = interaction;
  if (!member.roles.cache.has(cache.allowedRoleID)) {
    return interaction.reply('You do not have permission to use this command.');
  }

  switch (commandName) {
    case 'refresh':
      const interval = options.getInteger('interval');
      if (interval) {
        await updateRefreshInterval(interval);
        return interaction.reply(`Refresh interval set to ${interval}ms.`);
      } else {
        await refreshPostsCache();
        return interaction.reply('Posts cache has been manually refreshed.');
      }

    case 'disable-api':
      cache.isApiEnabled = false;
      return interaction.reply('API access has been disabled.');

    case 'enable-api':
      cache.isApiEnabled = true;
      return interaction.reply('API access has been enabled.');

    case 'disable-ran':
      cache.isRanEnabled = false;
      return interaction.reply('The /ran page and its routes are now disabled.');

    case 'enable-ran':
      cache.isRanEnabled = true;
      return interaction.reply('The /ran page and its routes are now enabled.');

    case 'disable-ran-slug':
      cache.isRanSlugEnabled = false;
      return interaction.reply('The /ran/{slug} page is now disabled.');

    case 'enable-ran-slug':
      cache.isRanSlugEnabled = true;
      return interaction.reply('The /ran/{slug} page is now enabled.');

    case 'control-posts':
      const action = options.getString('action');
      const slug = options.getString('slug');

      if (!cache.posts[slug]) {
        return interaction.reply('Post not found.');
      }

      switch (action) {
        case 'hide':
          cache.posts[slug].visible = false;
          break;
        case 'show':
          cache.posts[slug].visible = true;
          break;
        case 'keep':
          cache.posts[slug].isPinned = true;
          break;
        default:
          return interaction.reply('Invalid action. Use show, hide, or keep.');
      }

      return interaction.reply(`Post with slug ${slug} has been updated: ${action}.`);
  }
});

// Function to normalize slugs
function normalizeSlug(slug) {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-') // Replace non-alphanumeric characters with dashes
    .replace(/^-+|-+$/g, ''); // Remove leading and trailing dashes
}

// Fetch posts from Hashnode with pagination
async function fetchPosts(query) {
  try {
    const response = await axios.post('https://gql.hashnode.com', { query }, {
      headers: {
        Authorization: `Bearer ${process.env.HASHNODE_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    return response.data;
  } catch (error) {
    console.error('Error fetching data from Hashnode:', error.message);
    throw error;
  }
}

// Fetch all posts with pagination
async function fetchAllPosts() {
  let allPosts = [];
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const query = `
      query {
        user(username: "${process.env.HASHNODE_USERNAME}") {
          publications(first: 1) {
            edges {
              node {
                posts(first: 50${cursor ? `, after: "${cursor}"` : ''}) {
                  edges {
                    node {
                      id
                      title
                      brief
                      slug
                      updatedAt
                    }
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
        }
      }
    `;

    const data = await fetchPosts(query);
    const posts = data.data.user.publications.edges[0].node.posts.edges.map(edge => edge.node);
    allPosts = allPosts.concat(posts);

    hasNextPage = data.data.user.publications.edges[0].node.posts.pageInfo.hasNextPage;
    cursor = data.data.user.publications.edges[0].node.posts.pageInfo.endCursor;
  }

  return allPosts;
}

// Server endpoints
app.get('/', async (req, res) => {
  if (!cache.isApiEnabled) {
    return res.status(403).send('API access is disabled.');
  }
  try {
    const posts = Object.values(cache.posts);
    const latestPosts = posts
      .filter(post => post.visible !== false) // Filter out hidden posts
      .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt))
      .slice(0, 3)
      .map(post => ({
        id: post.id,
        title: post.title,
        summary: post.brief,
        date: post.updatedAt || post.createdAt || 'No date',
        url: `/ran/${normalizeSlug(post.slug)}`,
      }));
    res.json(latestPosts);
  } catch (error) {
    console.error('Error fetching data from cache:', error.message);
    res.status(500).send({ error: 'Failed to load latest news. Please try again later.' });
  }
});

// Serve the /ran page with all news
app.get('/ran', async (req, res) => {
  if (!cache.isRanEnabled) {
    return res.status(403).send('The /ran page is disabled.');
  }
  try {
    const posts = Object.values(cache.posts)
      .filter(post => post.visible !== false)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

    const page = parseInt(req.query.page) || 1;
    const pageSize = 10;
    const totalPosts = posts.length;
    const totalPages = Math.ceil(totalPosts / pageSize);
    const paginatedPosts = posts.slice((page - 1) * pageSize, page * pageSize);

    res.json({
      posts: paginatedPosts,
      pagination: {
        currentPage: page,
        totalPages,
        totalPosts,
      },
    });
  } catch (error) {
    console.error('Error fetching data from cache:', error.message);
    res.status(500).send({ error: 'Failed to load news. Please try again later.' });
  }
});

// Serve individual post
app.get('/ran/:slug', async (req, res) => {
  if (!cache.isRanSlugEnabled) {
    return res.status(403).send('The /ran/{slug} page is disabled.');
  }
  const { slug } = req.params;
  try {
    const post = cache.posts[slug];
    if (post && post.visible !== false) {
      res.json(post);
    } else {
      res.status(404).send({ error: 'Post not found or is hidden.' });
    }
  } catch (error) {
    console.error('Error fetching individual post:', error.message);
    res.status(500).send({ error: 'Failed to load post. Please try again later.' });
  }
});

// Start server
client.login(process.env.DISCORD_TOKEN).then(() => {
  app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
});
