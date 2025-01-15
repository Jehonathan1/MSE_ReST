const express = require('express');
const router = express.Router();
const MSEService = require('../services/MSEService');

router.get('/shows', async (req, res) => {
    try {
        console.log('Fetching shows...');
        const shows = await MSEService.fetchAllShows();
        console.log('Shows fetched:', shows);
        res.json(shows);
    } catch (error) {
        console.error('Error fetching shows:', error);
        res.status(500).json({ error: 'Failed to fetch shows' });
    }
});

router.get('/profiles', async (req, res) => {
    try {
        const profiles = await MSEService.fetchProfiles();
        res.json(profiles);
    } catch (error) {
        console.error('Error fetching profiles:', error);
        res.status(500).json({ error: 'Failed to fetch profiles' });
    }
});

// Playlist content for table
router.get('/playlist-content', async (req, res, next) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({ error: 'Playlist URL is required' });
        }
        const content = await MSEService.fetchPlaylistContent(url);
        res.json(content);
    } catch (error) {
        next(error);
    }
});

// Playlist content for dropdown
router.get('/playlist-content-dropdown', async (req, res, next) => {
    try {
        const { url } = req.query;
        if (!url) {
            return res.status(400).json({ error: 'Playlist URL is required' });
        }
        const content = await MSEService.fetchPlaylistContentForDropdown(url);
        res.json(content);
    } catch (error) {
        next(error);
    }
});

router.post('/profile-command', async (req, res) => {
    try {
        const { commandUrl, elementUrl } = req.body;
        if (!commandUrl || !elementUrl) {
            return res.status(400).json({ error: 'Command URL and Element URL are required' });
        }
        await MSEService.executeProfileCommand(commandUrl, elementUrl);
        res.json({ success: true });
    } catch (error) {
        console.error('Error executing command:', error);
        res.status(500).json({ error: 'Failed to execute command' });
    }
});

module.exports = router;