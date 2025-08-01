const express = require('express');
const { body, validationResult, query } = require('express-validator');
const Post = require('../models/Post');
const Tag = require('../models/Tag');
const { authenticateToken, requireAdmin, optionalAuth } = require('../middleware/auth');
const { upload, handleUploadError } = require('../middleware/upload');
const aiService = require('../services/aiService');

const router = express.Router();

// Validation rules
const postValidation = [
  body('title')
    .trim()
    .isLength({ min: 3, max: 200 })
    .withMessage('Title must be between 3 and 200 characters'),
  body('content')
    .trim()
    .isLength({ min: 10 })
    .withMessage('Content must be at least 10 characters long'),
  body('status')
    .optional()
    .isIn(['draft', 'published'])
    .withMessage('Status must be either draft or published')
];

// @route   GET /api/posts
// @desc    Get all published posts with pagination
// @access  Public
router.get('/', 
  [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('Limit must be between 1 and 50'),
    query('tag').optional().trim(),
    query('search').optional().trim(),
    query('sort').optional().isIn(['newest', 'oldest', 'popular', 'trending']).withMessage('Invalid sort option')
  ],
  optionalAuth,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;
      const { tag, search, sort = 'newest' } = req.query;

      // Build query
      let query = { status: 'published' };

      // Add tag filter
      if (tag) {
        const tagDoc = await Tag.findOne({ slug: tag });
        if (tagDoc) {
          query.tags = tagDoc._id;
        } else {
          return res.json({
            posts: [],
            totalPosts: 0,
            currentPage: page,
            totalPages: 0,
            hasNextPage: false,
            hasPrevPage: false
          });
        }
      }

      // Add search filter
      if (search) {
        query.$text = { $search: search };
      }

      // Build sort options
      let sortOptions = {};
      switch (sort) {
        case 'oldest':
          sortOptions = { publishedAt: 1 };
          break;
        case 'popular':
          sortOptions = { viewCount: -1, publishedAt: -1 };
          break;
        case 'trending':
          sortOptions = { likeCount: -1, viewCount: -1, publishedAt: -1 };
          break;
        default: // newest
          sortOptions = { publishedAt: -1 };
      }

      // Get posts with pagination
      const posts = await Post.find(query)
        .populate('author', 'name profileImage')
        .populate('tags', 'name slug color')
        .select('-content') // Exclude content for list view
        .sort(sortOptions)
        .skip(skip)
        .limit(limit)
        .lean();

      // Get total count for pagination
      const totalPosts = await Post.countDocuments(query);
      const totalPages = Math.ceil(totalPosts / limit);

      res.json({
        posts,
        totalPosts,
        currentPage: page,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      });
    } catch (error) {
      console.error('Get posts error:', error);
      res.status(500).json({
        message: 'Failed to fetch posts',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

// @route   GET /api/posts/recent
// @desc    Get recent published posts
// @access  Public
router.get('/recent', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    
    const posts = await Post.find({ status: 'published' })
      .populate('author', 'name profileImage')
      .populate('tags', 'name slug color')
      .select('title slug excerpt coverImage publishedAt viewCount likeCount commentCount readingTime')
      .sort({ publishedAt: -1 })
      .limit(limit)
      .lean();

    res.json({ posts });
  } catch (error) {
    console.error('Get recent posts error:', error);
    res.status(500).json({
      message: 'Failed to fetch recent posts',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// @route   GET /api/posts/:id
// @desc    Get single post by ID or slug
// @access  Public
router.get('/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Try to find by ID first, then by slug
    let post;
    
    try {
      // Try to find by ObjectId first
      post = await Post.findById(id)
        .populate('author', 'name profileImage email')
        .populate('tags', 'name slug color')
        .lean();
    } catch (error) {
      // If ID is invalid (not a valid ObjectId), try by slug
      if (error.name === 'CastError') {
        post = await Post.findOne({ slug: id })
          .populate('author', 'name profileImage email')
          .populate('tags', 'name slug color')
          .lean();
      } else {
        throw error;
      }
    }

    // If not found by ID, try by slug
    if (!post) {
      post = await Post.findOne({ slug: id })
        .populate('author', 'name profileImage email')
        .populate('tags', 'name slug color')
        .lean();
    }

    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if post is published or user is admin
  if (post.status !== 'published' && (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super_admin'))) {
    return res.status(404).json({ message: 'Post not found' });
  }

    // Increment view count if post is published
    if (post.status === 'published') {
      await Post.findByIdAndUpdate(post._id, { $inc: { viewCount: 1 } });
      post.viewCount += 1;
    }

    res.json({ post });
  } catch (error) {
    console.error('Get post error:', error);
    if (error.name === 'CastError') {
      return res.status(404).json({ message: 'Post not found' });
    }
    res.status(500).json({
      message: 'Failed to fetch post',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// @route   POST /api/posts
// @desc    Create new post
// @access  Private (Any authenticated user)
router.post('/',
  authenticateToken,
  upload.single('coverImage'),
  handleUploadError,
  postValidation,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      const { title, content, excerpt, tags = [], status = 'draft', seoTitle, seoDescription, featured = false } = req.body;

      // Handle cover image
      let coverImage = '';
      if (req.file) {
        coverImage = `/uploads/posts/${req.file.filename}`;
      }

      // Process tags - find existing or create new ones
      const tagIds = [];
      const tagNames = Array.isArray(tags) ? tags : tags.split(',').map(tag => tag.trim());
      
      for (const tagName of tagNames) {
        if (tagName) {
          let tag = await Tag.findOne({ name: tagName.toLowerCase() });
          if (!tag) {
            tag = new Tag({ name: tagName.toLowerCase() });
            await tag.save();
          }
          tagIds.push(tag._id);
        }
      }

      // Create post
      const post = new Post({
        title,
        content,
        excerpt,
        coverImage,
        author: req.user._id,
        tags: tagIds,
        status,
        seoTitle,
        seoDescription,
        featured
      });

      await post.save();
      
      // Update tag post counts
      await Tag.updateMany(
        { _id: { $in: tagIds } },
        { $inc: { postCount: 1 } }
      );

      // Populate the post for response
      const populatedPost = await Post.findById(post._id)
        .populate('author', 'name profileImage')
        .populate('tags', 'name slug color');

      res.status(201).json({
        message: 'Post created successfully',
        post: populatedPost
      });
    } catch (error) {
      console.error('Create post error:', error);
      console.error('Error stack:', error.stack);
      res.status(500).json({
        message: 'Failed to create post',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
);

// @route   PUT /api/posts/:id
// @desc    Update post
// @access  Private (Any authenticated user)
router.put('/:id',
  authenticateToken,
  upload.single('coverImage'),
  handleUploadError,
  postValidation,
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      const { id } = req.params;
      const { title, content, excerpt, tags = [], status, seoTitle, seoDescription, featured } = req.body;

      const post = await Post.findById(id);
      if (!post) {
        return res.status(404).json({ message: 'Post not found' });
      }

      // Check if user is the author of the post
      if (post.author.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: 'You can only edit your own posts' });
      }

      // Handle cover image
      if (req.file) {
        post.coverImage = `/uploads/posts/${req.file.filename}`;
      }

      // Process tags
      const tagIds = [];
      const tagNames = Array.isArray(tags) ? tags : tags.split(',').map(tag => tag.trim());
      
      for (const tagName of tagNames) {
        if (tagName) {
          let tag = await Tag.findOne({ name: tagName.toLowerCase() });
          if (!tag) {
            tag = new Tag({ name: tagName.toLowerCase() });
            await tag.save();
          }
          tagIds.push(tag._id);
        }
      }

      // Update tag post counts (remove from old tags, add to new tags)
      const oldTagIds = post.tags || [];
      const removedTagIds = oldTagIds.filter(tagId => !tagIds.includes(tagId.toString()));
      const addedTagIds = tagIds.filter(tagId => !oldTagIds.includes(tagId));

      await Tag.updateMany(
        { _id: { $in: removedTagIds } },
        { $inc: { postCount: -1 } }
      );

      await Tag.updateMany(
        { _id: { $in: addedTagIds } },
        { $inc: { postCount: 1 } }
      );

      // Update post
      Object.assign(post, {
        title,
        content,
        excerpt,
        tags: tagIds,
        status,
        seoTitle,
        seoDescription,
        featured: featured !== undefined ? featured : post.featured
      });

      await post.save();

      // Populate the post for response
      const populatedPost = await Post.findById(post._id)
        .populate('author', 'name profileImage')
        .populate('tags', 'name slug color');

      res.json({
        message: 'Post updated successfully',
        post: populatedPost
      });
    } catch (error) {
      console.error('Update post error:', error);
      if (error.name === 'CastError') {
        return res.status(404).json({ message: 'Post not found' });
      }
      res.status(500).json({
        message: 'Failed to update post',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

// @route   DELETE /api/posts/:id
// @desc    Delete post
// @access  Private (Any authenticated user)
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Check if user is the author of the post
    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'You can only delete your own posts' });
    }

    // Update tag post counts
    await Tag.updateMany(
      { _id: { $in: post.tags } },
      { $inc: { postCount: -1 } }
    );

    await Post.findByIdAndDelete(id);

    res.json({ message: 'Post deleted successfully' });
  } catch (error) {
    console.error('Delete post error:', error);
    if (error.name === 'CastError') {
      return res.status(404).json({ message: 'Post not found' });
    }
    res.status(500).json({
      message: 'Failed to delete post',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// @route   POST /api/posts/:id/like
// @desc    Like/unlike a post
// @access  Private
router.post('/:id/like', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    const post = await Post.findById(id);
    if (!post || post.status !== 'published') {
      return res.status(404).json({ message: 'Post not found' });
    }

    // For simplicity, we'll just increment the like count
    // In a more complex system, you might track who liked what
    post.likeCount += 1;
    await post.save();

    res.json({ 
      message: 'Post liked successfully',
      likeCount: post.likeCount 
    });
  } catch (error) {
    console.error('Like post error:', error);
    if (error.name === 'CastError') {
      return res.status(404).json({ message: 'Post not found' });
    }
    res.status(500).json({
      message: 'Failed to like post',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// @route   POST /api/posts/:id/summarize
// @desc    Generate AI summary for a post
// @access  Public
router.post('/:id/summarize', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const post = await Post.findById(id);
    if (!post || post.status !== 'published') {
      return res.status(404).json({ message: 'Post not found' });
    }

    if (!aiService.isAvailable()) {
      return res.status(503).json({ 
        message: 'AI service is not available at the moment' 
      });
    }

    const summary = await aiService.summarizeBlogPost(post.content);

    res.json({ 
      message: 'Summary generated successfully',
      summary 
    });
  } catch (error) {
    console.error('Summarize post error:', error);
    res.status(500).json({
      message: 'Failed to generate summary',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// @route   POST /api/posts/generate-ai
// @desc    Generate AI blog post
// @access  Private (Any authenticated user)
router.post('/generate-ai',
  authenticateToken,
  [
    body('title').trim().isLength({ min: 3, max: 200 }).withMessage('Title is required and must be between 3-200 characters'),
    body('tone').optional().trim(),
    body('keywords').optional().isArray()
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      if (!aiService.isAvailable()) {
        console.error('AI service not available - GEMINI_API_KEY missing or invalid');
        return res.status(503).json({ 
          message: 'AI service is not available. Please check server configuration.',
          error: 'GEMINI_API_KEY not configured'
        });
      }

      const { title, tone = 'informative', keywords = [] } = req.body;

      const content = await aiService.generateBlogPost(title, tone, keywords);
      
      // Generate meta description
      const metaDescription = await aiService.generateMetaDescription(title, content);

      res.json({
        message: 'Blog post generated successfully',
        generatedContent: {
          title,
          content,
          seoDescription: metaDescription
        }
      });
    } catch (error) {
      console.error('Generate AI post error:', error);
      console.error('Error stack:', error.stack);
      console.error('Request body:', req.body);
      res.status(500).json({
        message: 'Failed to generate blog post',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
);

// @route   POST /api/posts/generate-content
// @desc    Generate AI content for existing post
// @access  Private (Any authenticated user)
router.post('/generate-content',
  authenticateToken,
  [
    body('prompt').trim().isLength({ min: 3 }).withMessage('Prompt is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      if (!aiService.isAvailable()) {
        return res.status(503).json({ 
          message: 'AI service is not available at the moment' 
        });
      }

      const { prompt } = req.body;

      // Use the generateBlogPost method with the prompt as title for content generation
      const content = await aiService.generateBlogPost(prompt, 'informative', []);

      res.json({
        message: 'Content generated successfully',
        data: { content }
      });
    } catch (error) {
      console.error('Generate content error:', error);
      res.status(500).json({
        message: 'Failed to generate content',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

// @route   POST /api/posts/improve-title
// @desc    Generate improved title variations
// @access  Private (Any authenticated user)
router.post('/improve-title',
  authenticateToken,
  [
    body('title').trim().isLength({ min: 3 }).withMessage('Title is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      if (!aiService.isAvailable()) {
        return res.status(503).json({ 
          message: 'AI service is not available at the moment' 
        });
      }

      const { title } = req.body;

      const improvedTitles = await aiService.generateSEOTitles(title, 3);
      // Return the first improved title as the main suggestion
      const improvedTitle = improvedTitles && improvedTitles.length > 0 ? improvedTitles[0] : title;

      res.json({
        message: 'Title improved successfully',
        data: { title: improvedTitle, alternatives: improvedTitles }
      });
    } catch (error) {
      console.error('Improve title error:', error);
      res.status(500).json({
        message: 'Failed to improve title',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

// @route   POST /api/posts/generate-excerpt
// @desc    Generate excerpt from content
// @access  Private (Any authenticated user)
router.post('/generate-excerpt',
  authenticateToken,
  [
    body('content').trim().isLength({ min: 10 }).withMessage('Content is required')
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      if (!aiService.isAvailable()) {
        return res.status(503).json({ 
          message: 'AI service is not available at the moment' 
        });
      }

      const { content } = req.body;

      const excerpt = await aiService.summarizeBlogPost(content, 200);

      res.json({
        message: 'Excerpt generated successfully',
        data: { excerpt }
      });
    } catch (error) {
      console.error('Generate excerpt error:', error);
      res.status(500).json({
        message: 'Failed to generate excerpt',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
      });
    }
  }
);

// @route   GET /api/posts/ai-status
// @desc    Check AI service status
// @access  Public
router.get('/ai-status', async (req, res) => {
  try {
    const isAvailable = aiService.isAvailable();
    
    res.json({
      aiService: {
        available: isAvailable,
        status: isAvailable ? 'ready' : 'unavailable',
        message: isAvailable ? 'AI service is ready' : 'AI service is not configured'
      },
      environment: {
        nodeEnv: process.env.NODE_ENV,
        hasGeminiKey: !!process.env.GEMINI_API_KEY,
        geminiKeyLength: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : 0
      }
    });
  } catch (error) {
    console.error('AI status check error:', error);
    res.status(500).json({
      message: 'Failed to check AI service status',
      error: error.message
    });
  }
});

module.exports = router;
