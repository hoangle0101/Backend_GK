const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('uploads'));

// Tạo thư mục uploads nếu chưa có
if (!fs.existsSync('uploads')) {
  fs.mkdirSync('uploads');
}

// Cấu hình Multer cho upload ảnh
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    // Cho phép mọi mime type image/* hoặc kiểm tra extension
    const allowedExts = /jpeg|jpg|png|gif|webp/;
    const extname = allowedExts.test(path.extname(file.originalname || '').toLowerCase().replace('.', ''));
    const isImageMime = typeof file.mimetype === 'string' && file.mimetype.toLowerCase().startsWith('image/');

    if (isImageMime || extname) {
      return cb(null, true);
    }

    // Nếu vẫn muốn thông báo chi tiết để debug, trả về message rõ ràng
    cb(new Error(`Chỉ chấp nhận file ảnh! originalname=${file.originalname} mimetype=${file.mimetype}`));
  }
});

// Kết nối MongoDB
mongoose.connect('mongodb://127.0.0.1:27017/user_management', {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log('Kết nối MongoDB thành công'))
.catch(err => console.error(' Lỗi kết nối MongoDB:', err));

// Schema User
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  image: { type: String, default: '' }
});

const User = mongoose.model('User', userSchema);

// API Đăng nhập
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    
    if (user) {
      res.json({ 
        success: true, 
        message: 'Đăng nhập thành công',
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          image: user.image
        }
      });
    } else {
      res.status(401).json({ 
        success: false, 
        message: 'Tên đăng nhập hoặc mật khẩu không đúng' 
      });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API Lấy danh sách users
app.get('/api/users', async (req, res) => {
  try {
    let query = {};
    if (req.query.search) {
      const search = req.query.search.trim();
      query = {
        $or: [
          { username: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ]
      };
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const sortBy = req.query.sortBy || 'username';
    const sortOrder = req.query.sortOrder === 'desc' ? -1 : 1;

    const users = await User.find(query)
   
      .sort({ [sortBy]: sortOrder })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      users,
      total,
      page,
      pages: Math.ceil(total / limit)
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API Lấy thông tin user theo ID
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (user) {
      res.json({ success: true, user });
    } else {
      res.status(404).json({ success: false, message: 'Không tìm thấy user' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API Thêm user mới
app.post('/api/users', upload.single('image'), async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const image = req.file ? `/uploads/${req.file.filename}` : '';
    
    const newUser = new User({ username, email, password, image });
    await newUser.save();
    
    res.status(201).json({ 
      success: true, 
      message: 'Thêm user thành công',
      user: {
        id: newUser._id,
        username: newUser.username,
        email: newUser.email,
        image: newUser.image
      }
    });
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({ 
        success: false, 
        message: 'Username hoặc email đã tồn tại' 
      });
    } else {
      res.status(500).json({ success: false, message: error.message });
    }
  }
});

// API Cập nhật user
app.put('/api/users/:id', (req, res, next) => {
  // Kiểm tra kiểu content-type
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('multipart/form-data')) {
    // Nếu là multipart thì dùng Multer
    upload.single('image')(req, res, function (err) {
      if (err) {
        return res.status(400).json({ success: false, message: err.message });
      }
      updateUserHandler(req, res);
    });
  } else {
    // Nếu là application/json thì parse như bình thường
    updateUserHandler(req, res);
  }
});

async function updateUserHandler(req, res) {
  try {
    const { username, email, password } = req.body;
    const updateData = { username, email, password };

    // Nếu có file ảnh mới thì xử lý ảnh
    if (req.file) {
      // Xóa ảnh cũ nếu có
      const oldUser = await User.findById(req.params.id);
      if (oldUser && oldUser.image) {
        const oldImagePath = path.join(__dirname, oldUser.image);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
      updateData.image = `/uploads/${req.file.filename}`;
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    )

    if (user) {
      res.json({
        success: true,
        message: 'Cập nhật user thành công',
        user
      });
    } else {
      res.status(404).json({ success: false, message: 'Không tìm thấy user' });
    }
  } catch (error) {
    if (error.code === 11000) {
      res.status(400).json({
        success: false,
        message: 'Username hoặc email đã tồn tại'
      });
    } else {
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

// API Xóa user
app.delete('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    
    if (user) {
      // Xóa ảnh nếu có
      if (user.image) {
        const imagePath = path.join(__dirname, user.image);
        if (fs.existsSync(imagePath)) {
          fs.unlinkSync(imagePath);
        }
      }
      
      await User.findByIdAndDelete(req.params.id);
      res.json({ success: true, message: 'Xóa user thành công' });
    } else {
      res.status(404).json({ success: false, message: 'Không tìm thấy user' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// API Tìm kiếm users
app.get('/api/users/search/:keyword', async (req, res) => {
  try {
    const keyword = req.params.keyword;
    const users = await User.find({
      $or: [
        { username: { $regex: keyword, $options: 'i' } },
        { email: { $regex: keyword, $options: 'i' } }
      ]
    }).select('-password');
    
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(` Server đang chạy tại http://localhost:${PORT}`);
});