/*\
title: $:/plugins/tiddlywiki/multiwikiserver/sql-tiddler-store.js
type: application/javascript
module-type: library

Functions to perform basic tiddler operations with a sqlite3 database

\*/

(function() {

/*
Create a tiddler store. Options include:

databasePath - path to the database file (can be ":memory:" to get a temporary database)
adminWiki - reference to $tw.Wiki object into which entity state tiddlers should be saved
*/
function SqlTiddlerStore(options) {
	options = options || {};
	this.adminWiki = options.adminWiki || $tw.wiki;
	this.entityStateTiddlerPrefix = "$:/state/multiwikiserver/";
	// Create the database
	var databasePath = options.databasePath || ":memory:";
	this.db = new $tw.sqlite3.Database(databasePath,{verbose: undefined && console.log});
}

SqlTiddlerStore.prototype.close = function() {
	this.db.close();
	this.db = undefined;
};

SqlTiddlerStore.prototype.runStatement = function(sql,params) {
	params = params || {};
	const statement = this.db.prepare(sql);
	statement.run(params);
};

SqlTiddlerStore.prototype.runStatementGet = function(sql,params) {
	params = params || {};
	const statement = this.db.prepare(sql);
	return statement.get(params);
};

SqlTiddlerStore.prototype.runStatementGetAll = function(sql,params) {
	params = params || {};
	const statement = this.db.prepare(sql);
	return statement.all(params);
};

SqlTiddlerStore.prototype.runStatements = function(sqlArray) {
	for(const sql of sqlArray) {
		this.runStatement(sql);
	}
};

SqlTiddlerStore.prototype.saveEntityStateTiddler = function(tiddler) {
	this.adminWiki.addTiddler(new $tw.Tiddler(tiddler,{title: this.entityStateTiddlerPrefix + tiddler.title}));
};

SqlTiddlerStore.prototype.updateAdminWiki = function() {
	// Update bags
	for(const bagInfo of this.listBags()) {
		this.saveEntityStateTiddler({
			title: "bags/" + bagInfo.bag_name,
			"bag-name": bagInfo.bag_name,
			text: ""
		});
	}
	// Update recipes
	for(const recipeInfo of this.listRecipes()) {
		this.saveEntityStateTiddler({
			title: "recipes/" + recipeInfo.recipe_name,
			"recipe-name": recipeInfo.recipe_name,
			text: "",
			list: $tw.utils.stringifyList(this.getRecipeBags(recipeInfo.recipe_name))
		});
	}
};

SqlTiddlerStore.prototype.createTables = function() {
	this.runStatements([`
		-- Bags have names and access control settings
		CREATE TABLE IF NOT EXISTS bags (
			bag_id INTEGER PRIMARY KEY,
			bag_name TEXT UNIQUE,
			accesscontrol TEXT
		)
	`,`
		-- Recipes have names...
		CREATE TABLE IF NOT EXISTS recipes (
			recipe_id INTEGER PRIMARY KEY,
			recipe_name TEXT UNIQUE
		)
	`,`
		-- ...and recipes also have an ordered list of bags
		CREATE TABLE IF NOT EXISTS recipe_bags (
			recipe_id INTEGER,
			bag_id INTEGER,
			position INTEGER,
			FOREIGN KEY (recipe_id) REFERENCES recipes(recipe_id) ON UPDATE CASCADE ON DELETE CASCADE,
			FOREIGN KEY (bag_id) REFERENCES bags(bag_id) ON UPDATE CASCADE ON DELETE CASCADE,
			UNIQUE (recipe_id, bag_id)
		)
	`,`
		-- Tiddlers are contained in bags and have titles
		CREATE TABLE IF NOT EXISTS tiddlers (
			tiddler_id INTEGER PRIMARY KEY,
			bag_id INTEGER,
			title TEXT,
			FOREIGN KEY (bag_id) REFERENCES bags(bag_id) ON UPDATE CASCADE ON DELETE CASCADE,
			UNIQUE (bag_id, title)
		)
	`,`
		-- Tiddlers also have unordered lists of fields, each of which has a name and associated value
		CREATE TABLE IF NOT EXISTS fields (
			tiddler_id INTEGER,
			field_name TEXT,
			field_value TEXT,
			FOREIGN KEY (tiddler_id) REFERENCES tiddlers(tiddler_id) ON UPDATE CASCADE ON DELETE CASCADE,
			UNIQUE (tiddler_id, field_name)
		)
	`]);
};

SqlTiddlerStore.prototype.logTables = function() {
	var self = this;
	function sqlLogTable(table) {
		console.log(`TABLE ${table}:`);
		let statement = self.db.prepare(`select * from ${table}`);
		for(const row of statement.all()) {
			console.log(row);
		}
	}
	const tables = ["recipes","bags","recipe_bags","tiddlers","fields"];
	for(const table of tables) {
		sqlLogTable(table);
	}
};

SqlTiddlerStore.prototype.listBags = function() {
	const rows = this.runStatementGetAll(`
		SELECT bag_name, accesscontrol
		FROM bags
		ORDER BY bag_name
	`);
	return rows;
};

SqlTiddlerStore.prototype.createBag = function(bagname) {
	// Run the queries
	this.runStatement(`
		INSERT OR IGNORE INTO bags (bag_name, accesscontrol)
		VALUES ($bag_name, '')
	`,{
		bag_name: bagname
	});
	this.runStatement(`
		UPDATE bags
		SET accesscontrol = $accesscontrol
		WHERE bag_name = $bag_name
	`,{
		bag_name: bagname,
		accesscontrol: "[some access control stuff]"
	});
	this.saveEntityStateTiddler({
		title: "bags/" + bagname,
		"bag-name": bagname,
		text: ""
	});
};

SqlTiddlerStore.prototype.listRecipes = function() {
	const rows = this.runStatementGetAll(`
		SELECT recipe_name
		FROM recipes
		ORDER BY recipe_name
	`);
	return rows;
};

SqlTiddlerStore.prototype.createRecipe = function(recipename,bagnames) {
	// Run the queries
	this.runStatement(`
		-- Create the entry in the recipes table if required
		INSERT OR IGNORE INTO recipes (recipe_name)
		VALUES ($recipe_name)
	`,{
		recipe_name: recipename
	});
	this.runStatement(`
		-- Delete existing recipe_bags entries for this recipe
		DELETE FROM recipe_bags WHERE recipe_id = (SELECT recipe_id FROM recipes WHERE recipe_name = $recipe_name)
	`,{
		recipe_name: recipename
	});
	this.runStatement(`
		INSERT INTO recipe_bags (recipe_id, bag_id, position)
		SELECT r.recipe_id, b.bag_id, j.key as position
		FROM recipes r
		JOIN bags b
		INNER JOIN json_each($bag_names) AS j ON j.value = b.bag_name
		WHERE r.recipe_name = $recipe_name
	`,{
		recipe_name: recipename,
		bag_names: JSON.stringify(bagnames)
	});
	this.saveEntityStateTiddler({
		title: "recipes/" + recipename,
		"recipe-name": recipename,
		text: "",
		list: $tw.utils.stringifyList(bagnames)
	});
};

SqlTiddlerStore.prototype.saveBagTiddler = function(tiddlerFields,bagname) {
	// Update the tiddlers table
	this.runStatement(`
		INSERT OR REPLACE INTO tiddlers (bag_id, title)
		VALUES (
			(SELECT bag_id FROM bags WHERE bag_name = $bag_name),
			$title
		)
	`,{
		title: tiddlerFields.title,
		bag_name: bagname
	});
	// Update the fields table
	this.runStatement(`
		INSERT OR REPLACE INTO fields (tiddler_id, field_name, field_value)
		SELECT
			t.tiddler_id,
			json_each.key AS field_name,
			json_each.value AS field_value
		FROM (
			SELECT tiddler_id
			FROM tiddlers
			WHERE bag_id = (
				SELECT bag_id
				FROM bags
				WHERE bag_name = $bag_name
			) AND title = $title
		) AS t
		JOIN json_each($field_values) AS json_each
	`,{
		title: tiddlerFields.title,
		bag_name: bagname,
		field_values: JSON.stringify(Object.assign({},tiddlerFields,{title: undefined}))
	});
};

SqlTiddlerStore.prototype.saveRecipeTiddler = function(tiddlerFields,recipename) {
	// Find the topmost bag in the recipe
	var row = this.runStatementGet(`
		SELECT b.bag_name
		FROM bags AS b
		JOIN (
			SELECT rb.bag_id
			FROM recipe_bags AS rb
			WHERE rb.recipe_id = (
				SELECT recipe_id
				FROM recipes
				WHERE recipe_name = $recipe_name
			)
			ORDER BY rb.position DESC
			LIMIT 1
		) AS selected_bag
		ON b.bag_id = selected_bag.bag_id
	`,{
		recipe_name: recipename
	});
	// Save the tiddler to the topmost bag
	this.saveBagTiddler(tiddlerFields,row.bag_name);
	return row.bag_name;
};

SqlTiddlerStore.prototype.deleteTiddler = function(title,bagname) {
	// Run the queries
	this.runStatement(`
		DELETE FROM fields
		WHERE tiddler_id IN (
			SELECT t.tiddler_id
			FROM tiddlers AS t
			INNER JOIN bags AS b ON t.bag_id = b.bag_id
			WHERE b.bag_name = $bag_name AND t.title = $title
		)
	`,{
		title: title,
		bag_name: bagname
	});
	this.runStatement(`
		DELETE FROM tiddlers
		WHERE bag_id = (
			SELECT bag_id
			FROM bags
			WHERE bag_name = $bag_name
		) AND title = $title
	`,{
		title: title,
		bag_name: bagname
	});
};

SqlTiddlerStore.prototype.getBagTiddler = function(title,bagname) {
	const rows = this.runStatementGetAll(`
		SELECT field_name, field_value
		FROM fields
		WHERE tiddler_id = (
			SELECT t.tiddler_id
			FROM bags AS b
			INNER JOIN tiddlers AS t ON b.bag_id = t.bag_id
			WHERE t.title = $title AND b.bag_name = $bag_name
		)
	`,{
		title: title,
		bag_name: bagname
	});
	if(rows.length === 0) {
		return null;
	} else {
		return rows.reduce((accumulator,value) => {
			accumulator[value["field_name"]] = value.field_value;
			return accumulator;
		},{title: title});	
	}
};

/*
Returns {bag_name:, tiddler: {fields}}
*/
SqlTiddlerStore.prototype.getRecipeTiddler = function(title,recipename) {
	const rowTiddlerId = this.runStatementGet(`	
		SELECT t.tiddler_id, b.bag_name
		FROM bags AS b
		INNER JOIN recipe_bags AS rb ON b.bag_id = rb.bag_id
		INNER JOIN recipes AS r ON rb.recipe_id = r.recipe_id
		INNER JOIN tiddlers AS t ON b.bag_id = t.bag_id
		WHERE r.recipe_name = $recipe_name
		AND t.title = $title
		ORDER BY rb.position DESC
	`,{
		title: title,
		recipe_name: recipename
	});
	if(!rowTiddlerId) {
		return null;
	}
	// Get the fields
	const rows = this.runStatementGetAll(`
		SELECT field_name, field_value
		FROM fields
		WHERE tiddler_id = $tiddler_id
	`,{
		tiddler_id: rowTiddlerId.tiddler_id,
		recipe_name: recipename
	});
	return {
		bag_name: rowTiddlerId.bag_name,
		tiddler: rows.reduce((accumulator,value) => {
				accumulator[value["field_name"]] = value.field_value;
				return accumulator;
			},{title: title})
	};
};

/*
Get the titles of the tiddlers in a bag. Returns an empty array for bags that do not exist
*/
SqlTiddlerStore.prototype.getBagTiddlers = function(bagname) {
	const rows = this.runStatementGetAll(`
		SELECT DISTINCT title
		FROM tiddlers
		WHERE bag_id IN (
			SELECT bag_id
			FROM bags
			WHERE bag_name = $bag_name
		)
		ORDER BY title ASC
	`,{
		bag_name: bagname
	});
	return rows.map(value => value.title);
};

/*
Get the titles of the tiddlers in a recipe. Returns an empty array for recipes that do not exist
*/
SqlTiddlerStore.prototype.getRecipeTiddlers = function(recipename) {
	const rows = this.runStatementGetAll(`
		SELECT DISTINCT title
		FROM tiddlers
		WHERE bag_id IN (
			SELECT bag_id
			FROM recipe_bags
			WHERE recipe_id = (
				SELECT recipe_id
				FROM recipes
				WHERE recipe_name = $recipe_name
			)
		)
		ORDER BY title ASC
	`,{
		recipe_name: recipename
	});
	return rows.map(value => value.title);
};

/*
Get the names of the bags in a recipe. Returns an empty array for recipes that do not exist
*/
SqlTiddlerStore.prototype.getRecipeBags = function(recipename) {
	const rows = this.runStatementGetAll(`
		SELECT bags.bag_name
		FROM bags
		JOIN (
			SELECT rb.bag_id
			FROM recipe_bags AS rb
			JOIN recipes AS r ON rb.recipe_id = r.recipe_id
			WHERE r.recipe_name = $recipe_name
			ORDER BY rb.position
		) AS bag_priority ON bags.bag_id = bag_priority.bag_id
	`,{
		recipe_name: recipename
	});
	return rows.map(value => value.bag_name);
};

exports.SqlTiddlerStore = SqlTiddlerStore;

})();