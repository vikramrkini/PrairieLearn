const express = require('express');
const asyncHandler = require('express-async-handler');
const router = express.Router();
const {loadSqlEquiv} = require('@prairielearn/postgres');
const sqldb = require('@prairielearn/postgres');
const sql = loadSqlEquiv(__filename);

router.use((req, res, next) => {
  res.locals.policies = []; // Initialize policies array in res.locals
  next();
});


router.get(
  '/',
  asyncHandler(async (req, res) => {
    const params = {
      assessment_id: res.locals.assessment.id,
      current_user_id: res.locals.user.uid,
      current_assessment_title : res.locals.assessment.title
    };
    const result = await sqldb.queryAsync(sql.selectQuery, params);
    res.locals.policies = result.rows
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    res.render(__filename.replace(/\.js$/, '.ejs'), {
      policies: res.locals.policies,
      assessment_id: params.assessment_id,
      current_user_id: params.current_user_id,
      current_assessment_title: params.current_assessment_title
    });
  })
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (req.body.__action === 'add_new_override') {
    const params = {
      assessment_id: req.body.assessment_id,
      created_at: new Date(req.body.created_at),
      created_by: req.body.current_user_id,
      credit: req.body.credit,
      end_date: new Date(req.body.end_date),
      group_id: req.body.group_id || null,
      note: req.body.note || null,
      start_date: new Date(req.body.start_date),
      type: req.body.type,
      user_id: req.body.user_id,
    };

    const insertQuery = sql.insertQuery;

    await sqldb.queryAsync(insertQuery, params);
    res.redirect(req.originalUrl);
  
  } 
  
  else if (req.body.__action === 'delete_override')
    {
      const delete_params = {
        assessment_id: req.body.assessment_id,
        user_id: req.body.user_id,
        group_id: req.body.group_id,
      };
      // const result_after_delete = await sqldb.queryAsync(deleteQuery, delete_params);
      // console.log(result_after_delete)
      const result_after_delete = await sqldb.queryAsync(sql.deleteQuery, delete_params);
      console.log(result_after_delete.rows)
      res.locals.policies = result_after_delete.rows;
      res.render(__filename.replace(/\.js$/, '.ejs'), {
        policies: res.locals.policies,
        assessment_id: delete_params.assessment_id,
        current_user_id: delete_params.current_user_id,
        current_assessment_title: delete_params.current_assessment_title
      });
      
      // res.redirect(req.originalUrl);
    }

    else if (req.body.__action === 'edit_override') {
      const edit_params = {
        assessment_id: res.locals.assessment.id,
        created_at: new Date(req.body.created_at),
        created_by: res.locals.user.uid,
        credit: req.body.credit,
        end_date: new Date(req.body.end_date),
        group_id: req.body.group_id || null,
        note: req.body.note || null,
        start_date: new Date(req.body.start_date),
        type: req.body.type,
        user_id: req.body.user_id,
        
      };

      const updateQuery = sql.updateQuery;

      await sqldb.queryAsync(updateQuery, edit_params);
      res.redirect(req.originalUrl);
    }
  })
);


module.exports = router;
